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
 * MCP over SSE:
 * - GET /      -> OK rápido (para que "Probar conexión" no se quede cargando)
 * - GET /sse   -> abre canal SSE
 * - POST /messages -> recibe mensajes JSON-RPC
 */

let clients = [];

function startSSE(req, res) {
  console.log("[SSE] conectado", req.headers["user-agent"] || "-");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // IMPORTANTE: endpoint en texto plano (no JSON)
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  // Evento inicial (informativo)
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
}

// 1) / debe responder rápido (para el botón "Probar conexión")
app.get("/", (req, res) => {
  res.status(200).send("OK (MCP server activo). Usa /sse para SSE.");
});

// 2) SSE real aquí
app.get("/sse", (req, res) => startSSE(req, res));

// Endpoint de salud opcional
app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * POST /messages: JSON-RPC mínimo
 * Añadimos compatibilidad extra:
 * - tools.list y tools.call (algunos clientes usan punto en vez de /)
 */
app.post("/messages", (req, res) => {
  const msg = req.body;

  console.log("[MCP] incoming:", JSON.stringify(msg));

  if (!msg || typeof msg !== "object") {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { id, method, params } = msg;

  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2025-03-26",
      serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  }

  // tools/list (slash)
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

  // tools.list (punto)
  if (method === "tools.list") {
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

  // tools/call (slash)
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "ping") {
      const text = args.text ? String(args.text) : "";
      return reply({
        content: [{ type: "text", text: `pong ${text}`.trim() }],
      });
    }

    return fail(-32601, "Tool not found");
  }

  // tools.call (punto)
  if (method === "tools.call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "ping") {
      const text = args.text ? String(args.text) : "";
      return reply({
        content: [{ type: "text", text: `pong ${text}`.trim() }],
      });
    }

    return fail(-32601, "Tool not found");
  }

  return fail(-32601, "Method not found");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v5 compat tools.list/tools.call iniciado");
});
