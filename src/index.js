// LP WA Bridge — mini backend Baileys multi-tenant para LP CRM
// Cada tenant tiene su propia sesión persistida en disco.
// REST API protegida por API_KEY.

import express from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me-please";
const SESSION_DIR = process.env.SESSION_DIR || "./sessions";
const WEBHOOK_URL = process.env.WEBHOOK_URL || null; // ej: https://inmobiliarialp.com/api/wa-incoming
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MAX_MESSAGES_KEPT = 500; // por tenant

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// ━━━ Auth middleware ━━━
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/health") return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ━━━ State per tenant ━━━
const tenants = new Map(); // tenantId → { sock, qr, status, messages: [] }

function getTenant(tenantId) {
  if (!tenants.has(tenantId)) {
    tenants.set(tenantId, {
      sock: null,
      qr: null,
      status: "disconnected", // disconnected | connecting | qr | connected
      messages: [],
      number: null,
      lastConnectedAt: null
    });
  }
  return tenants.get(tenantId);
}

function normalizePhone(p) {
  if (!p) return "";
  let n = String(p).replace(/[^\d]/g, "");
  if (n.length === 10) n = "52" + n;
  return n;
}

function jidToPhone(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

function phoneToJid(phone) {
  const n = normalizePhone(phone);
  return `${n}@s.whatsapp.net`;
}

// ━━━ Webhook hacia el CRM ━━━
async function notifyCrm(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": WEBHOOK_SECRET
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    logger.warn({ err: e.message }, "webhook_failed");
  }
}

// ━━━ Persistencia simple del log de mensajes en disco ━━━
async function appendMessageLog(tenantId, record) {
  try {
    const dir = path.join(SESSION_DIR, tenantId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "messages.jsonl");
    await fs.appendFile(file, JSON.stringify(record) + "\n");
  } catch (e) {
    logger.warn({ err: e.message }, "log_failed");
  }
}

async function loadMessageLog(tenantId) {
  try {
    const file = path.join(SESSION_DIR, tenantId, "messages.jsonl");
    const txt = await fs.readFile(file, "utf-8");
    return txt.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ━━━ Conectar sesión Baileys ━━━
async function connectTenant(tenantId) {
  const tenant = getTenant(tenantId);
  if (tenant.sock && tenant.status === "connected") return tenant;
  tenant.status = "connecting";

  const authDir = path.join(SESSION_DIR, tenantId, "auth");
  await fs.mkdir(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    browser: ["LP CRM", "Chrome", "120.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  tenant.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      tenant.qr = await QRCode.toDataURL(qr);
      tenant.status = "qr";
      logger.info({ tenantId }, "qr_generated");
    }
    if (connection === "open") {
      tenant.status = "connected";
      tenant.qr = null;
      tenant.number = jidToPhone(sock.user?.id);
      tenant.lastConnectedAt = new Date().toISOString();
      logger.info({ tenantId, number: tenant.number }, "connected");
      notifyCrm({ type: "connected", tenantId, number: tenant.number });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      tenant.status = loggedOut ? "disconnected" : "connecting";
      tenant.sock = null;
      logger.warn({ tenantId, code, loggedOut }, "connection_closed");
      if (!loggedOut) {
        setTimeout(() => connectTenant(tenantId).catch(e => logger.error(e)), 3000);
      } else {
        // Borra sesión, próxima vez generará QR nuevo
        try { await fs.rm(authDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  // ━━━ Mensajes entrantes ━━━
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (m.key.fromMe) continue; // Solo entrantes
      const from = jidToPhone(m.key.remoteJid);
      // Ignora grupos por ahora
      if (m.key.remoteJid?.endsWith("@g.us")) continue;
      const text = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption
        || m.message?.videoMessage?.caption
        || "";
      const record = {
        ts: new Date((m.messageTimestamp || Date.now()/1000) * 1000).toISOString(),
        direction: "in",
        from,
        to: tenant.number,
        message_id: m.key.id,
        type: Object.keys(m.message || { unknown: 1 })[0] || "text",
        text,
        profile_name: m.pushName || null,
        tenant_id: tenantId
      };
      tenant.messages.push(record);
      if (tenant.messages.length > MAX_MESSAGES_KEPT) tenant.messages.shift();
      await appendMessageLog(tenantId, record);
      notifyCrm({ type: "message_in", tenantId, message: record });
      logger.info({ tenantId, from, len: text.length }, "msg_in");
    }
  });

  return tenant;
}

// ━━━ Endpoints ━━━

app.get("/", (req, res) => res.json({ name: "lp-wa-bridge", version: "1.0.0", status: "ok" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Inicia/reanuda sesión y devuelve estado
app.post("/session/:tenantId/start", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId || tenantId.length > 60) return res.status(400).json({ error: "bad_tenant" });
  try {
    const tenant = await connectTenant(tenantId);
    res.json({ ok: true, status: tenant.status, number: tenant.number });
  } catch (e) {
    logger.error(e, "start_failed");
    res.status(500).json({ error: "start_failed", message: e.message });
  }
});

// Status de la sesión
app.get("/session/:tenantId/status", (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  res.json({
    ok: true,
    status: tenant.status,
    number: tenant.number,
    has_qr: !!tenant.qr,
    last_connected_at: tenant.lastConnectedAt
  });
});

// QR como dataURL
app.get("/session/:tenantId/qr", (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  if (!tenant.qr) return res.status(404).json({ error: "no_qr", status: tenant.status });
  res.json({ ok: true, qr: tenant.qr, status: tenant.status });
});

// Logout/desconectar
app.post("/session/:tenantId/logout", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  try {
    if (tenant.sock) await tenant.sock.logout().catch(() => {});
    tenant.sock = null;
    tenant.status = "disconnected";
    tenant.qr = null;
    tenant.number = null;
    const authDir = path.join(SESSION_DIR, tenantId, "auth");
    await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "logout_failed", message: e.message });
  }
});

// Enviar mensaje de texto
app.post("/session/:tenantId/send", async (req, res) => {
  const { tenantId } = req.params;
  const { to, text } = req.body || {};
  const tenant = getTenant(tenantId);
  if (tenant.status !== "connected" || !tenant.sock) {
    return res.status(400).json({ error: "not_connected", status: tenant.status });
  }
  const phone = normalizePhone(to);
  const body = (text || "").toString().slice(0, 4000).trim();
  if (!phone || !body) return res.status(400).json({ error: "missing_to_or_text" });
  try {
    const jid = phoneToJid(phone);
    // Verificar existencia (opcional pero útil)
    const exists = await tenant.sock.onWhatsApp(jid).catch(() => null);
    if (!exists || !exists[0]?.exists) {
      return res.status(400).json({ error: "number_not_on_whatsapp", phone });
    }
    const result = await tenant.sock.sendMessage(jid, { text: body });
    const record = {
      ts: new Date().toISOString(),
      direction: "out",
      from: tenant.number,
      to: phone,
      message_id: result.key.id,
      type: "text",
      text: body,
      tenant_id: tenantId
    };
    tenant.messages.push(record);
    if (tenant.messages.length > MAX_MESSAGES_KEPT) tenant.messages.shift();
    await appendMessageLog(tenantId, record);
    res.json({ ok: true, message_id: result.key.id });
  } catch (e) {
    logger.error(e, "send_failed");
    res.status(500).json({ error: "send_failed", message: e.message });
  }
});

// Leer conversación con un número
app.get("/session/:tenantId/conversation", async (req, res) => {
  const { tenantId } = req.params;
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: "no_phone" });

  // Mezcla in-memory + log persistido
  const persisted = await loadMessageLog(tenantId);
  const tenant = getTenant(tenantId);
  const seen = new Set();
  const all = [...persisted, ...tenant.messages]
    .filter(m => {
      const k = m.message_id || (m.ts + m.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .filter(m => normalizePhone(m.from) === phone || normalizePhone(m.to) === phone)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const lastIn = [...all].reverse().find(m => m.direction === "in");
  const within24h = lastIn ? (Date.now() - new Date(lastIn.ts).getTime()) < 24 * 3600 * 1000 : false;
  res.json({ ok: true, messages: all, within24h, last_inbound: lastIn?.ts || null });
});

// Verificar si un número existe en WhatsApp
app.get("/session/:tenantId/check", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  if (tenant.status !== "connected" || !tenant.sock) {
    return res.status(400).json({ error: "not_connected" });
  }
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: "no_phone" });
  try {
    const r = await tenant.sock.onWhatsApp(phoneToJid(phone));
    res.json({ ok: true, exists: !!r?.[0]?.exists, phone });
  } catch (e) {
    res.status(500).json({ error: "check_failed", message: e.message });
  }
});

// ━━━ Start ━━━
app.listen(PORT, () => {
  logger.info({ port: PORT, webhook: !!WEBHOOK_URL }, "lp-wa-bridge listo");
});
