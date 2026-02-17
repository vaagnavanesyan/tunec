import * as net from "node:net";
import type { RelayRequest, RelayResponse } from "./types.js";

const TAG = "Relay";
const BATCH_SIZE_THRESHOLD = 4096;
const BATCH_FLUSH_MS = 10;

interface InboundState {
  buffer: Buffer[];
  flushTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Manages real TCP connections on behalf of VPN clients.
 *
 * Port of RelayExecutor.kt — each connectionId maps to a live TCP socket
 * to the destination server. Incoming data from those sockets is pushed
 * back through the `sendResponse` callback.
 */
export class RelayManager {
  private connections = new Map<string, net.Socket>();
  private inboundState = new Map<string, InboundState>();

  constructor(
    private readonly sendResponse: (response: RelayResponse) => void
  ) {}

  /** Dispatch an incoming relay request from AppOne. */
  handleRequest(request: RelayRequest): void {
    switch (request.type) {
      case "connect":
        this.handleConnect(
          request.connectionId,
          request.destIp,
          request.destPort
        );
        break;
      case "data":
        this.handleData(request.connectionId, request.payload);
        break;
      case "disconnect":
        this.handleDisconnect(request.connectionId);
        break;
      case "shutdown_write":
        this.handleShutdownWrite(request.connectionId);
        break;
    }
  }

  /** Close all managed connections. */
  shutdown(): void {
    for (const [id, state] of this.inboundState) {
      if (state.flushTimeout != null) clearTimeout(state.flushTimeout);
    }
    this.inboundState.clear();
    for (const [id, socket] of this.connections) {
      console.log(`[${TAG}] Shutdown: closing ${id}`);
      socket.destroy();
    }
    this.connections.clear();
  }

  private flushInbound(connectionId: string): void {
    const state = this.inboundState.get(connectionId);
    if (!state || state.buffer.length === 0) return;
    if (state.flushTimeout != null) {
      clearTimeout(state.flushTimeout);
      state.flushTimeout = null;
    }
    const concatenated = Buffer.concat(state.buffer);
    state.buffer.length = 0;
    this.sendResponse({
      type: "data",
      connectionId,
      payload: concatenated.toString("base64"),
    });
  }

  // ── Internal handlers ──────────────────────────────────────────────────

  private handleConnect(
    connectionId: string,
    destIp: string,
    destPort: number
  ): void {
    console.log(`[${TAG}] Connect ${connectionId} → ${destIp}:${destPort}`);

    this.inboundState.set(connectionId, { buffer: [], flushTimeout: null });

    const socket = net.createConnection(
      { host: destIp, port: destPort },
      () => {
        console.log(`[${TAG}] Connected ${connectionId}`);
        socket.setTimeout(0); // cancel connect-phase timeout once connected
        this.sendResponse({ type: "connected", connectionId });
      }
    );

    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => {
      //console.log(`[${TAG}] IN DATA ← ${connectionId} len=${chunk.length}`);
      const state = this.inboundState.get(connectionId);
      if (!state) return;
      state.buffer.push(chunk);
      const totalSize = state.buffer.reduce((s, b) => s + b.length, 0);
      if (totalSize >= BATCH_SIZE_THRESHOLD) {
        this.flushInbound(connectionId);
      } else if (state.flushTimeout == null) {
        state.flushTimeout = setTimeout(() => {
          this.flushInbound(connectionId);
        }, BATCH_FLUSH_MS);
      }
    });

    socket.on("close", () => {
      this.flushInbound(connectionId);
      this.inboundState.delete(connectionId);
      this.connections.delete(connectionId);
      console.log(`[${TAG}] Disconnected ${connectionId}`);
      this.sendResponse({ type: "disconnected", connectionId });
    });

    socket.on("error", (err: Error) => {
      this.flushInbound(connectionId);
      this.inboundState.delete(connectionId);
      this.connections.delete(connectionId);
      console.error(`[${TAG}] Error ${connectionId}:`, err.message);
      this.sendResponse({
        type: "error",
        connectionId,
        message: err.message,
      });
    });

    // Timeout for the connect phase (20 s — slow/congested paths may need more than 10 s)
    socket.setTimeout(20_000, () => {
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
    const state = this.inboundState.get(connectionId);
    if (state?.flushTimeout != null) {
      clearTimeout(state.flushTimeout);
    }
    this.inboundState.delete(connectionId);
    const socket = this.connections.get(connectionId);
    if (socket) {
      this.connections.delete(connectionId);
      socket.destroy();
      console.log(`[${TAG}] Disconnect ${connectionId}`);
    }
  }

  /** Half-close: client finished sending; server can still send response. */
  private handleShutdownWrite(connectionId: string): void {
    const socket = this.connections.get(connectionId);
    if (socket) {
      socket.end();
      console.log(`[${TAG}] Shutdown write ${connectionId}`);
    }
  }
}
