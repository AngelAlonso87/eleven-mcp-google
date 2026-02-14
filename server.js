require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("MCP Google server activo");
});

/**
 * MCP over SSE (mínimo para que ElevenLabs conecte)
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

  // Enviamos un evento inicial
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
});

app.post("/messages", (req, res) => {
  // Por ahora solo hacemos “echo” al canal SSE
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
