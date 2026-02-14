require("dotenv").config();
const express = require("express");

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

// URL pública
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

let clients = [];

function startSSE(req, res) {
  const ua = req.headers["user-agent"] || "-";
  console.log("[SSE] conectado", ua);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // 1) endpoint en texto plano
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  // 2) ready
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  // Mantener vivo
  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch (e) {}
  }, 15000);

  const clientId = Date.now();
  clients.push({ id: clientId, res, keepAlive });

  req.on("close", () => {
    clearInterval(keepAlive);
    clients = clients.filter((c) => c.id !== clientId);
    console.log("[SSE] desconectado", ua);
  });
}

// ✅ IMPORTANTE: / también abre SSE (porque ElevenLabs parece probar aquí)
app.get("/", (req, res) => startSSE(req, res));

// /sse también abre SSE
app.get("/sse", (req, res) => startSSE(req, res));

// health para pruebas humanas (opcional)
app.get("/health", (req, res) => res.status(200).send("OK"));

app.post("/messages", (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    console.log("[MCP] incoming:", JSON.stringify(msg));

    if (!msg || typeof msg !== "object") continue;

    const { id, method, params } = msg;

    // Notifications (sin id) -> 204
    if (id === undefined || id === null) {
      return res.status(204).end();
    }

    const reply = (result) => responses.push({ jsonrpc: "2.0", id, result });
    const fail = (code, message) =>
      responses.push({ jsonrpc: "2.0", id, error: { code, message } });

    if (method === "initialize") {
      reply({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
        capabilities: { tools: { listChanged: true } },
      });
      continue;
    }

    if (method === "tools/list" || method === "tools.list") {
      reply({
        tools: [
          {
            name: "ping",
            description: "Herramienta de prueba: responde pong.",
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
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v9 / y /sse como SSE + tools iniciado");
});
