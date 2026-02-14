require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

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

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

// ===========================
// SSE (legacy /sse) — pero anunciando /mcp
// ===========================
function startLegacySSE(req, res) {
  const ua = req.headers["user-agent"] || "-";
  console.log("[SSE-LEGACY] conectado", ua);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // ✅ CLAVE: aunque sea /sse, le decimos que POSTEE a /mcp
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/mcp\n\n`);

  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE legacy conectado"}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    console.log("[SSE-LEGACY] desconectado", ua);
  });
}

app.get("/sse", (req, res) => startLegacySSE(req, res));

// ===========================
// MCP “nuevo” /mcp (Streamable HTTP)
// + SSE opcional en GET /mcp
// ===========================
const sessions = new Map(); // sessionId -> { createdAt }

app.get("/mcp", (req, res) => {
  const accept = req.headers["accept"] || "";
  const ua = req.headers["user-agent"] || "-";

  // Solo SSE si lo piden
  if (!accept.includes("text/event-stream")) {
    return res.status(405).send("Method Not Allowed");
  }

  console.log("[SSE-MCP] conectado", ua);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // ✅ CAMBIO: añadimos endpoint + data JSON + ready (compatibilidad máxima)
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/mcp\n\n`);

  res.write(`data: ${JSON.stringify({ messages: `${baseUrl}/mcp` })}\n\n`);

  res.write(`event: ready\n`);
  res.write(`data: {"ok":true}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    console.log("[SSE-MCP] desconectado", ua);
  });
});

// Handler único para RPC (lo usamos en /mcp y /messages)
function handleRpc(req, res, sourceName) {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    console.log(`[${sourceName}] incoming:`, JSON.stringify(msg));

    if (!msg || typeof msg !== "object") continue;

    const { id, method, params } = msg;

    // Notificación sin id: ignorar sin romper
    if (id === undefined || id === null) continue;

    const reply = (result, extraHeaders = {}) => {
      Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
      responses.push({ jsonrpc: "2.0", id, result });
    };

    const fail = (code, message) =>
      responses.push({ jsonrpc: "2.0", id, error: { code, message } });

    if (method === "initialize") {
      const newSessionId = crypto.randomUUID();
      sessions.set(newSessionId, { createdAt: Date.now() });

      reply(
        {
          protocolVersion: params?.protocolVersion || "2025-03-26",
          serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
          capabilities: { tools: { listChanged: true } },
        },
        { "Mcp-Session-Id": newSessionId }
      );
      continue;
    }

    if (method === "tools/list" || method === "tools.list") {
      reply({
        tools: [
          {
            name: "ping",
            description: "Devuelve pong.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      });
      continue;
    }

    if (method === "tools/call" || method === "tools.call") {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === "ping") {
        const text = args.text ? String(args.text) : "";
        reply({ content: [{ type: "text", text: `pong ${text}`.trim() }] });
        continue;
      }
      fail(-32601, "Tool not found");
      continue;
    }

    fail(-32601, "Method not found");
  }

  if (responses.length === 0) return res.status(204).end();
  if (Array.isArray(body)) return res.json(responses);
  return res.json(responses[0]);
}

// ✅ Endpoint principal nuevo
app.post("/mcp", (req, res) => handleRpc(req, res, "MCP"));

// ✅ Alias: si ElevenLabs insiste en /messages, funcionará igual
app.post("/messages", (req, res) => handleRpc(req, res, "MCP-LEGACY-ALIAS"));

// Health
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v13 (SSE /mcp endpoint+data+ready) iniciado");
});
