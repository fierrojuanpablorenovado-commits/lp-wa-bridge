// LP WA Bridge — mini backend Baileys multi-tenant para LP CRM
// Soporta dos modos de vinculación:
//   - QR:          escanea con la cámara del celular
//   - Pairing Code: WhatsApp manda un código de 8 chars al número, lo tecleas en el CRM

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
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MAX_MESSAGES_KEPT = 500;

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
// status: disconnected | connecting | qr | pairing | connected
const tenants = new Map();

function getTenant(tenantId) {
  if (!tenants.has(tenantId)) {
    tenants.set(tenantId, {
      sock: null,
      qr: null,              // dataURL cuando status=qr
      pairingCode: null,     // "ABCD-1234" cuando status=pairing
      status: "disconnected",
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
  return jid ? jid.split("@")[0].split(":")[0] : "";
}

function phoneToJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

// ━━━ Webhook hacia el CRM ━━━
async function notifyCrm(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": WEBHOOK_SECRET },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    logger.warn({ err: e.message }, "webhook_failed");
  }
}

// ━━━ Persistencia de mensajes ━━━
async function appendMessageLog(tenantId, record) {
  try {
    const dir = path.join(SESSION_DIR, tenantId);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "messages.jsonl"), JSON.stringify(record) + "\n");
  } catch (e) {
    logger.warn({ err: e.message }, "log_failed");
  }
}

async function loadMessageLog(tenantId) {
  try {
    const txt = await fs.readFile(path.join(SESSION_DIR, tenantId, "messages.jsonl"), "utf-8");
    return txt.split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ━━━ Conectar sesión Baileys ━━━
// mode: "qr" (default) | "pairing" (requiere llamada posterior a requestPairing)
async function connectTenant(tenantId, mode = "qr") {
  const tenant = getTenant(tenantId);
  if (tenant.sock && tenant.status === "connected") return tenant;

  // Si ya hay socket arrancado esperando vinculación, no recrées
  if (tenant.sock && ["qr", "pairing", "connecting"].includes(tenant.status)) return tenant;

  tenant.status = "connecting";
  tenant.qr = null;
  tenant.pairingCode = null;

  const authDir = path.join(SESSION_DIR, tenantId, "auth");
  await fs.mkdir(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    // Para pairing code debemos deshabilitar la generación de QR
    ...(mode === "pairing" ? { mobile: false, printQRInTerminal: false } : {}),
    browser: ["LP CRM", "Chrome", "120.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  tenant.sock = sock;
  tenant.connectMode = mode;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR generado (modo qr)
    if (qr && mode === "qr") {
      tenant.qr = await QRCode.toDataURL(qr);
      tenant.status = "qr";
      logger.info({ tenantId }, "qr_generated");
    }

    if (connection === "open") {
      tenant.status = "connected";
      tenant.qr = null;
      tenant.pairingCode = null;
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
        // Reconexión automática (mantiene el mismo modo)
        setTimeout(() => connectTenant(tenantId, tenant.connectMode || "qr")
          .catch(e => logger.error(e)), 4000);
      } else {
        try { await fs.rm(authDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  // ━━━ Mensajes entrantes ━━━
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      if (m.key.remoteJid?.endsWith("@g.us")) continue; // sin grupos
      const from = jidToPhone(m.key.remoteJid);
      const text = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption
        || m.message?.videoMessage?.caption
        || "";
      const record = {
        ts: new Date((m.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
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

app.get("/", (req, res) => res.json({ name: "lp-wa-bridge", version: "1.1.0", status: "ok" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Status ──
app.get("/session/:tenantId/status", (req, res) => {
  const t = getTenant(req.params.tenantId);
  res.json({
    ok: true,
    status: t.status,
    number: t.number,
    has_qr: !!t.qr,
    has_pairing_code: !!t.pairingCode,
    last_connected_at: t.lastConnectedAt
  });
});

// ── Iniciar con QR ──
app.post("/session/:tenantId/start", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId || tenantId.length > 60) return res.status(400).json({ error: "bad_tenant" });
  try {
    const tenant = await connectTenant(tenantId, "qr");
    res.json({ ok: true, status: tenant.status, number: tenant.number });
  } catch (e) {
    res.status(500).json({ error: "start_failed", message: e.message });
  }
});

// ── Obtener QR ──
app.get("/session/:tenantId/qr", (req, res) => {
  const t = getTenant(req.params.tenantId);
  if (!t.qr) return res.status(404).json({ error: "no_qr", status: t.status });
  res.json({ ok: true, qr: t.qr, status: t.status });
});

// ── Iniciar con Pairing Code ──
// Paso 1: arranca el socket
app.post("/session/:tenantId/start-pairing", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId || tenantId.length > 60) return res.status(400).json({ error: "bad_tenant" });
  try {
    const tenant = await connectTenant(tenantId, "pairing");
    res.json({ ok: true, status: tenant.status });
  } catch (e) {
    res.status(500).json({ error: "start_failed", message: e.message });
  }
});

// ── Pairing Code ──
// Paso 2: solicita el código para el número dado
// Body: { phone: "3312345678" } (10 dígitos MX, le agrega 52 solo)
app.post("/session/:tenantId/request-pairing-code", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);

  if (!tenant.sock) {
    return res.status(400).json({ error: "no_socket", message: "Llama a /start-pairing primero." });
  }
  if (tenant.status === "connected") {
    return res.status(400).json({ error: "already_connected", number: tenant.number });
  }

  const rawPhone = req.body?.phone || "";
  const phone = normalizePhone(rawPhone);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: "bad_phone", message: "Manda 10 dígitos MX, ej: 3312345678" });
  }

  try {
    // Baileys genera el código — WhatsApp lo manda como notificación al número
    const code = await tenant.sock.requestPairingCode(phone);
    // Formatea como "ABCD-1234" si no viene con guion
    const formatted = code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
    tenant.pairingCode = formatted;
    tenant.status = "pairing";
    logger.info({ tenantId, phone }, "pairing_code_sent");
    res.json({ ok: true, code: formatted, phone });
  } catch (e) {
    logger.error(e, "pairing_code_failed");
    res.status(500).json({ error: "pairing_failed", message: e.message });
  }
});

// ── Logout ──
app.post("/session/:tenantId/logout", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  try {
    if (tenant.sock) await tenant.sock.logout().catch(() => {});
    tenant.sock = null;
    tenant.status = "disconnected";
    tenant.qr = null;
    tenant.pairingCode = null;
    tenant.number = null;
    const authDir = path.join(SESSION_DIR, tenantId, "auth");
    await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "logout_failed", message: e.message });
  }
});

// ── Enviar mensaje ──
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
    const exists = await tenant.sock.onWhatsApp(jid).catch(() => null);
    if (!exists?.[0]?.exists) {
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

// ── Conversación con un número ──
app.get("/session/:tenantId/conversation", async (req, res) => {
  const { tenantId } = req.params;
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: "no_phone" });

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
  const within24h = lastIn
    ? (Date.now() - new Date(lastIn.ts).getTime()) < 24 * 3600 * 1000
    : false;

  res.json({ ok: true, messages: all, within24h, last_inbound: lastIn?.ts || null });
});

// ── Verificar si número existe en WA ──
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
  logger.info({ port: PORT, webhook: !!WEBHOOK_URL }, "lp-wa-bridge listo — QR + Pairing Code");
});
