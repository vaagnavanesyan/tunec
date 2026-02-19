import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RelayManager } from "./relay.js";
import { parseRequest, serializeResponse } from "./protocol.js";

const PORT = Number(process.env.PORT) || 3000;
const TAG = "AppBack";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── WebSocket handling ──────────────────────────────────────────────────────

wss.on("connection", (ws: WebSocket) => {
  console.log(`[${TAG}] Client connected`);

  const relay = new RelayManager((response) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeResponse(response));
    }
  });

  ws.on("message", (raw: Buffer | string) => {
    if (!Buffer.isBuffer(raw)) {
      console.warn(`[${TAG}] Ignoring non-binary message`);
      return;
    }
    try {
      const request = parseRequest(raw);
      relay.handleRequest(request);
    } catch (err) {
      console.error(`[${TAG}] Invalid message:`, err);
    }
  });

  ws.on("close", () => {
    console.log(`[${TAG}] Client disconnected`);
    relay.shutdown();
  });

  ws.on("error", (err: Error) => {
    console.error(`[${TAG}] WebSocket error:`, err.message);
    relay.shutdown();
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[${TAG}] Listening on port ${PORT}`);
});
