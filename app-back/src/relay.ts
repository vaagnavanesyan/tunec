import * as net from "node:net";
import type { RelayRequest, RelayResponse } from "./types.js";

const TAG = "Relay";

/**
 * Manages real TCP connections on behalf of VPN clients.
 *
 * Port of RelayExecutor.kt — each connectionId maps to a live TCP socket
 * to the destination server. Incoming data from those sockets is pushed
 * back through the `sendResponse` callback.
 */
export class RelayManager {
  private connections = new Map<string, net.Socket>();

  constructor(
    private readonly sendResponse: (response: RelayResponse) => void,
  ) {}

  /** Dispatch an incoming relay request from AppOne. */
  handleRequest(request: RelayRequest): void {
    switch (request.type) {
      case "connect":
        this.handleConnect(request.connectionId, request.destIp, request.destPort);
        break;
      case "data":
        this.handleData(request.connectionId, request.payload);
        break;
      case "disconnect":
        this.handleDisconnect(request.connectionId);
        break;
    }
  }

  /** Close all managed connections. */
  shutdown(): void {
    for (const [id, socket] of this.connections) {
      console.log(`[${TAG}] Shutdown: closing ${id}`);
      socket.destroy();
    }
    this.connections.clear();
  }

  // ── Internal handlers ──────────────────────────────────────────────────

  private handleConnect(connectionId: string, destIp: string, destPort: number): void {
    console.log(`[${TAG}] Connect ${connectionId} → ${destIp}:${destPort}`);

    const socket = net.createConnection({ host: destIp, port: destPort }, () => {
      console.log(`[${TAG}] Connected ${connectionId}`);
      this.sendResponse({ type: "connected", connectionId });
    });

    socket.setNoDelay(true);

    // Reader — equivalent of startReader() in RelayExecutor.kt
    socket.on("data", (chunk: Buffer) => {
      console.log(`[${TAG}] IN DATA ← ${connectionId} len=${chunk.length}`);
      this.sendResponse({
        type: "data",
        connectionId,
        payload: chunk.toString("base64"),
      });
    });

    socket.on("close", () => {
      this.connections.delete(connectionId);
      console.log(`[${TAG}] Disconnected ${connectionId}`);
      this.sendResponse({ type: "disconnected", connectionId });
    });

    socket.on("error", (err: Error) => {
      this.connections.delete(connectionId);
      console.error(`[${TAG}] Error ${connectionId}:`, err.message);
      this.sendResponse({
        type: "error",
        connectionId,
        message: err.message,
      });
    });

    // Timeout for the connect phase (10 s, matching RelayExecutor.kt)
    socket.setTimeout(10_000, () => {
      console.error(`[${TAG}] Connect timeout ${connectionId}`);
      socket.destroy(new Error("connect timeout"));
    });

    this.connections.set(connectionId, socket);
  }

  private handleData(connectionId: string, base64Payload: string): void {
    const socket = this.connections.get(connectionId);
    if (!socket) {
      console.warn(`[${TAG}] Data for unknown connection ${connectionId}`);
      this.sendResponse({
        type: "error",
        connectionId,
        message: "unknown connection",
      });
      return;
    }

    try {
      const payload = Buffer.from(base64Payload, "base64");
      socket.write(payload);
    } catch (err) {
      console.error(`[${TAG}] Write error ${connectionId}:`, err);
      this.connections.delete(connectionId);
      socket.destroy();
      this.sendResponse({ type: "disconnected", connectionId });
    }
  }

  private handleDisconnect(connectionId: string): void {
    const socket = this.connections.get(connectionId);
    if (socket) {
      this.connections.delete(connectionId);
      socket.destroy();
      console.log(`[${TAG}] Disconnect ${connectionId}`);
    }
  }
}
