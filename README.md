# LP WA Bridge

Mini-backend de WhatsApp (Baileys) para LP CRM SaaS. Cada tenant escanea un QR con su WhatsApp y queda conectado. El CRM consume esta API REST para enviar/recibir mensajes y mostrarlos en el inbox por lead.

## Deploy en Railway (1 click)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/fierrojuanpablorenovado-commits/lp-wa-bridge)

### Variables que necesitas configurar

| Variable | Valor |
|---|---|
| `API_KEY` | Cadena random larga (mín 32 chars). Será la misma que pondrás en Vercel del CRM. |
| `WEBHOOK_URL` | `https://inmobiliarialp.com/api/wa-incoming` |
| `WEBHOOK_SECRET` | Otra cadena random — Railway la mandará en cada webhook para autenticar. |
| `PORT` | Lo asigna Railway, no lo toques. |

**Importante**: agrega un **Volume** montado en `/app/sessions` para persistir la sesión WhatsApp entre reinicios. Si no, cada redeploy te pide escanear QR otra vez.

## Endpoints

Todos requieren header `X-API-Key: <API_KEY>`.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/session/:tenantId/start` | Inicia/reanuda sesión. Devuelve estado. |
| `GET` | `/session/:tenantId/status` | Estado actual. |
| `GET` | `/session/:tenantId/qr` | QR como dataURL (solo si status=qr). |
| `POST` | `/session/:tenantId/logout` | Cierra sesión y borra credenciales. |
| `POST` | `/session/:tenantId/send` | Body: `{ to, text }`. Envía mensaje. |
| `GET` | `/session/:tenantId/conversation?phone=52133...` | Mensajes con un número. |
| `GET` | `/session/:tenantId/check?phone=52133...` | Verifica si número existe en WA. |

## Estados de sesión

- `disconnected` → sin sesión activa, hay que llamar `/start`
- `connecting` → estableciendo conexión
- `qr` → QR generado, esperando escaneo
- `connected` → operativa

## Local

```bash
npm install
API_KEY=mi-key node src/index.js
```
