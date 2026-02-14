require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

// LOGGER
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)` +
        ` IP=${req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "-"}` +
        ` UA=${req.headers["user-agent"] || "-"}`
    );
  });
  next();
});

/**
 * MCP over SSE (mínimo)
 * - GET /      -> SSE (por si ElevenLabs solo prueba la base)
 * - GET /sse   -> SSE
 * - POST /messages -> recibe mensajes
 */

let clients = [];

function startSSE(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Evento inicial
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
}

// ElevenLabs suele probar solo la base: lo hacemos SSE directo
app.get("/", (req, res) => startSSE(req, res));

// También mantenemos /sse
app.get("/sse", (req, res) => startSSE(req, res));

app.post("/messages", (req, res) => {
  const payload = req.body || {};

  for (const c of clients) {
    c.res.write(`event: message\n`);
    c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v2 SIN REDIRECT iniciado");
});
