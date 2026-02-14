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

// URL pública (para construir el endpoint correcto)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

/**
 * MCP over SSE (mínimo para que el cliente sepa:
 * 1) que hay SSE
 * 2) a qué URL enviar POST /messages
 */

let clients = [];

function startSSE(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // IMPORTANTE: decirle al cliente a dónde mandar los mensajes
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ uri: `${baseUrl}/messages` })}\n\n`);

  // Evento inicial (solo informativo)
  res.write(`event: ready\n`);
  res.write(`data: ${JSON.stringify({ ok: true, message: "SSE conectado" })}\n\n`);

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
}

// / es SSE directo (porque ElevenLabs suele probar solo la base)
app.get("/", (req, res) => startSSE(req, res));
// mantenemos /sse por si acaso
app.get("/sse", (req, res) => startSSE(req, res));

// Endpoint de salud para probar sin SSE (opcional pero útil)
app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * POST /messages: aquí llegan los mensajes (JSON-RPC)
 * Implementación mínima para que el cliente pueda:
 * - pedir lista de herramientas
 * - llamar a una herramienta de prueba
 */
app.post("/messages", (req, res) => {
  const msg = req.body;

  // Log del cuerpo (para ver qué envía ElevenLabs)
  console.log("[MCP] incoming:", JSON.stringify(msg));

  // Si llega algo raro o vacío
  if (!msg || typeof msg !== "object") {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { jsonrpc, id, method, params } = msg;

  // Respuesta helper
  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  // Métodos mínimos
  if (method === "initialize") {
    return reply({
      serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  }

  if (method === "tools/list") {
    return reply({
      tools: [
        {
          name: "ping",
          description: "Herramienta de prueba: responde pong.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Texto opcional" },
            },
          },
        },
      ],
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "ping") {
      const text = args.text ? String(args.text) : "";
      return reply({
        content: [
          { type: "text", text: `pong ${text}`.trim() },
        ],
      });
    }

    return fail(-32601, "Tool not found");
  }

  return fail(-32601, "Method not found");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v3 ENDPOINT+TOOLS iniciado");
});
