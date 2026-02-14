require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// =====================
// 1) LOGGER (ver llamadas)
// =====================
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

// URL pública (para construir URLs absolutas)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

// =====================================================
// A) TRANSPORTE “ANTIGUO” (HTTP+SSE, pre-2025-03-26)
//    - GET  /sse       -> SSE con evento "endpoint"
//    - POST /messages  -> JSON-RPC
// =====================================================
let sseClients = [];

function startLegacySSE(req, res) {
  console.log("[SSE-LEGACY] conectado", req.headers["user-agent"] || "-");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // PRIMERO endpoint (texto plano), como esperan clientes antiguos
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  // Luego ready
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE legacy conectado"}\n\n`);

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  req.on("close", () => {
    console.log("[SSE-LEGACY] desconectado", req.headers["user-agent"] || "-");
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
}

// SSE legacy
app.get("/sse", (req, res) => startLegacySSE(req, res));

// POST legacy messages (JSON-RPC)
app.post("/messages", (req, res) => {
  const msg = req.body;
  console.log("[MCP-LEGACY] incoming:", JSON.stringify(msg));

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

  if (method === "tools/list" || method === "tools.list") {
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

  if (method === "tools/call" || method === "tools.call") {
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

// =====================================================
// B) TRANSPORTE NUEVO (Streamable HTTP, 2025-03-26)
//    - Un solo endpoint: /mcp
//    - POST /mcp  -> JSON-RPC (responde JSON)
//    - GET  /mcp  -> opcional SSE (si el cliente lo pide)
//    - Soporta Mcp-Session-Id
// =====================================================

const sessions = new Map(); // sessionId -> { createdAt }

// GET /mcp: si el cliente pide SSE, abrimos stream; si no, 405
app.get("/mcp", (req, res) => {
  const accept = req.headers["accept"] || "";
  if (!accept.includes("text/event-stream")) {
    return res.status(405).send("Method Not Allowed");
  }

  console.log("[SSE-MCP] conectado", req.headers["user-agent"] || "-");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // En Streamable HTTP, en GET NO debemos enviar "endpoint".
  // Este stream es para notificaciones servidor->cliente (opcional).
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE /mcp conectado"}\n\n`);

  req.on("close", () => {
    console.log("[SSE-MCP] desconectado", req.headers["user-agent"] || "-");
  });
});

// POST /mcp: JSON-RPC “nuevo”
app.post("/mcp", (req, res) => {
  const msg = req.body;
  console.log("[MCP] incoming:", JSON.stringify(msg));

  if (!msg || typeof msg !== "object") {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const sessionId = req.headers["mcp-session-id"];
  const { id, method, params } = msg;

  const reply = (result, extraHeaders = {}) => {
    Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
    return res.json({ jsonrpc: "2.0", id, result });
  };

  const fail = (code, message) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  // initialize: creamos sesión y devolvemos Mcp-Session-Id
  if (method === "initialize") {
    const newSessionId = crypto.randomUUID();
    sessions.set(newSessionId, { createdAt: Date.now() });

    return reply(
      {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
        capabilities: { tools: {} },
      },
      { "Mcp-Session-Id": newSessionId }
    );
  }

  // Si el cliente ya usa sesión, aceptamos; si no, también (para no ser estrictos)
  if (sessionId && !sessions.has(sessionId)) {
    // Sesión desconocida/expirada
    return res.status(404).send("Session not found");
  }

  if (method === "tools/list" || method === "tools.list") {
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

  if (method === "tools/call" || method === "tools.call") {
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

// =====================
// HEALTH / HOME
// =====================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v6 (legacy /sse+/messages + nuevo /mcp) iniciado");
});
