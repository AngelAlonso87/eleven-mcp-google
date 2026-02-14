require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

/**
 * LOGGER (ver cada llamada que llega al servidor)
 */
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

// Root: redirige a /sse para que ElevenLabs entre al SSE si solo prueba la URL base
app.get("/", (req, res) => {
  res.redirect(302, "/sse");
});

/**
 * MCP over SSE (mínimo)
 * - GET  /sse       -> abre canal SSE
 * - POST /messages  -> recibe mensajes
 */

let clients = [];

app.get("/sse", (req, res) => {
  // Headers SSE
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
});

app.post("/messages", (req, res) => {
  const payload = req.body || {};

  // Emitimos a todos los clientes SSE conectados
  for (const c of clients) {
    c.res.write(`event: message\n`);
    c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor MCP (SSE) iniciado");
});
