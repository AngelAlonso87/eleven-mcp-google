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

// URL pública (para construir el endpoint correcto)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

/**
 * MCP over SSE:
 * - GET /      -> OK rápido (botón "Probar conexión")
 * - GET /sse   -> abre canal SSE
 * - POST /messages -> JSON-RPC MCP
 */

let clients = [];

function startSSE(req, res) {
  console.log("[SSE] conectado", req.headers["user-agent"] || "-");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const baseUrl = getBaseUrl(req);

  // Endpoint en texto plano
  res.write(`event: endpoint\n`);
  res.write(`data: ${baseUrl}/messages\n\n`);

  // Evento inicial (informativo)
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true,"message":"SSE conectado"}\n\n`);

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  // Mantener vivo el SSE (evita que proxies lo corten)
  const keepAlive = setInterval(() => {
    try {
      res.write(`event: ping\n`);
      res.write(`data: {}\n\n`);
    } catch (e) {
      // si el stream ya está cerrado, el close limpiará
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients = clients.filter((c) => c.id !== clientId);
  });
}

// 1) / responde rápido
app.get("/", (req, res) => {
  res.status(200).send("OK (MCP server activo). Usa /sse para SSE.");
});

// 2) SSE real
app.get("/sse", (req, res) => startSSE(req, res));

// Health opcional
app.get("/health", (req, res) => {
  res.send("OK");
});

// Helper: enviar a SSE a todos los conectados (debug)
function broadcast(eventName, payload) {
  for (const c of clients) {
    c.res.write(`event: ${eventName}\n`);
    c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

/**
 * POST /messages: JSON-RPC mínimo compatible con MCP
 */
app.post("/messages", (req, res) => {
  const body = req.body;

  // Soportar batch (array) o single (objeto)
  const messages = Array.isArray(body) ? body : [body];

  const responses = [];

  for (const msg of messages) {
    console.log("[MCP] incoming:", JSON.stringify(msg));

    if (!msg || typeof msg !== "object") {
      // si es batch y un item viene mal, respondemos error solo para ese
      responses.push({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error / Invalid JSON" },
      });
      continue;
    }

    const { id, method, params } = msg;

    // Notificación (sin id) => NO responder con JSON (muy importante)
    if (id === undefined || id === null) {
      if (method === "initialized") {
        // el cliente avisa que terminó el init
        // no hay respuesta
        continue;
      }
      // otras notificaciones: ignorar
      continue;
    }

    const reply = (result) => responses.push({ jsonrpc: "2.0", id, result });
    const fail = (code, message) =>
      responses.push({ jsonrpc: "2.0", id, error: { code, message } });

    // initialize
    if (method === "initialize") {
      reply({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        serverInfo: { name: "eleven-mcp-google", version: "1.0.0" },
        // IMPORTANTE: tools con listChanged suele ayudar a que el cliente haga tools/list
        capabilities: { tools: { listChanged: true } },
      });
      continue;
    }

    // tools/list (slash) o tools.list (punto)
    if (method === "tools/list" || method === "tools.list") {
      reply({
        tools: [
          {
            name: "ping",
            description: "Herramienta de prueba: responde pong.",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string", description: "Texto opcional" },
              },
              additionalProperties: false,
            },
          },
        ],
      });
      continue;
    }

    // tools/call (slash) o tools.call (punto)
    if (method === "tools/call" || method === "tools.call") {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === "ping") {
        const text = args.text ? String(args.text) : "";
        const out = `pong${text ? " " + text : ""}`;
        reply({ content: [{ type: "text", text: out }] });

        // debug por SSE (opcional)
        broadcast("tool_used", { tool: "ping", args, out });

        continue;
      }

      fail(-32601, "Tool not found");
      continue;
    }

    fail(-32601, "Method not found");
  }

  // Si era todo notificaciones (sin id), devolvemos 204
  if (responses.length === 0) {
    return res.status(204).end();
  }

  // Si el request original era batch, respondemos batch
  if (Array.isArray(body)) {
    return res.json(responses);
  }

  // Si era single, devolvemos el primer response
  return res.json(responses[0]);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVIDOR MCP v6 (initialized + keepalive + batch) iniciado");
});
