import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RelayManager } from "./relay.js";
import type { RelayRequest } from "./types.js";

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
      ws.send(JSON.stringify(response));
    }
  });

  ws.on("message", (raw: Buffer | string) => {
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf-8");
      const request: RelayRequest = JSON.parse(text);
      console.log(`[${TAG}] ← ${request.type} ${request.connectionId}`);
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
