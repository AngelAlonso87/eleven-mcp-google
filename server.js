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

// URL pública
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

/**
 * MCP over SSE:
 * - GET /      -> OK rápido
 * - GET /sse   -> SSE
 * - POST /messages -> JSON-RPC
 */

let clients = [];

function startSSE(req, res) {
  const ua = req.headers["user-agent"] || "-";
  console.log("[SSE] conectado", ua);

  // Headers SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Evita buffering en algunos proxys
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Mantener vivo el socket
  req.socket?.setKeepAlive?.(true);

  const baseUrl = getBaseUrl(req);

  // Decirle a ElevenLabs dónde postear mensajes
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  // Evento inicial
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  // ✅ LATIDO: cada 15s mandamos un comentario SSE para que no se corte
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`); // comentario SSE (no es evento)
    } catch (e) {
      // si falla, se limpiará en close
    }
  }, 15000);

  const clientId = Date.now();
  clients.push({ id: clientId, res, heartbeat });

  req.on("close", () => {
    clearInterval(heartbeat);
    clients = clients.filter((c) => c.id !== clientId);
    console.log("[SSE] desconectado", ua);
  });
}

// / rápido
app.get("/", (req, res) => {
  res.status(200).send("OK (MCP server activo). Usa /sse para SSE.");
});

// SSE real
app.get("/sse", (req, res) => startSSE(req, res));

// health
app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * POST /messages: JSON-RPC
 */
app.post("/messages", (req, res) => {
  const msg = req.body;

  console.log("[MCP] incoming:", JSON.stringify(msg));

  if (!msg || typeof msg !== "object") {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { id, method, params } = msg;
  const isNotification = typeof id === "undefined" || id === null;

  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  // ✅ Notifications típicas: no deben bloquear nada
  if (method === "notifications/initialized" || method === "notifications.initialized") {
    console.log("[MCP] notification: initialized");
    return res.status(204).end();
  }
  if (method === "notifications/cancelled" || method === "notifications.cancelled") {
    console.log("[MCP] notification: cancelled");
    return res.status(204).end();
  }
  if (isNotification) {
    console.log("[MCP] notification desconocida:", method);
    return res.status(204).end();
  }

  // ✅ initialize: anunciar tools
  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2025-03-26",
      serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
      capabilities: {
        tools: { listChanged: true },
      },
    });
  }

  // tools/list (slash y punto)
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

  // tools/call (slash y punto)
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

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v8 SSE heartbeat + notifications + tools iniciado");
});
