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

  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

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

// SSE tanto en / como en /sse
app.get("/", (req, res) => startSSE(req, res));
app.get("/sse", (req, res) => startSSE(req, res));
app.get("/health", (req, res) => res.status(200).send("OK"));

app.post("/messages", (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];

  const responses = [];
  let sawOnlyNotifications = true;

  for (const msg of messages) {
    console.log("[MCP] incoming:", JSON.stringify(msg));

    if (!msg || typeof msg !== "object") {
      continue;
    }

    const { id, method, params } = msg;

    // Notificación (sin id): NO respondemos por cada una.
    if (id === undefined || id === null) {
      // aceptamos initialized y cualquiera sin romper
      continue;
    }

    // Si hay id, NO es solo notificación
    sawOnlyNotifications = false;

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

  // Si SOLO hubo notificaciones
  if (sawOnlyNotifications) {
    return res.status(204).end();
  }

  // Si era batch, devolvemos batch; si no, devolvemos single
  if (Array.isArray(body)) return res.json(responses);
  return res.json(responses[0] || { jsonrpc: "2.0", id: null, result: {} });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v10 batch-safe + SSE root iniciado");
});
