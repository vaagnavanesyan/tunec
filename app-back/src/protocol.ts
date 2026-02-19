import type { RelayRequest, RelayResponse } from "./types.js";

const TYPE_CONNECT = 0x01;
const TYPE_DATA = 0x02;
const TYPE_DISCONNECT = 0x03;
const TYPE_SHUTDOWN_WRITE = 0x04;

const TYPE_CONNECTED = 0x01;
const TYPE_DISCONNECTED = 0x03;
const TYPE_ERROR = 0x04;

function ensureRemaining(buf: Buffer, offset: number, need: number): void {
  if (offset + need > buf.length) {
    throw new Error(`Protocol: truncated (need ${need} at offset ${offset}, length ${buf.length})`);
  }
}

function readString(buf: Buffer, offset: { value: number }): string {
  ensureRemaining(buf, offset.value, 2);
  const len = buf.readUInt16BE(offset.value);
  offset.value += 2;
  ensureRemaining(buf, offset.value, len);
  const s = buf.toString("utf-8", offset.value, offset.value + len);
  offset.value += len;
  return s;
}

function readBytes(buf: Buffer, offset: { value: number }): Buffer {
  ensureRemaining(buf, offset.value, 4);
  const len = buf.readUInt32BE(offset.value);
  offset.value += 4;
  ensureRemaining(buf, offset.value, len);
  const chunk = buf.subarray(offset.value, offset.value + len);
  offset.value += len;
  return chunk;
}

/**
 * Parse a binary relay request (AppOne → AppBack).
 * Format matches Kotlin RelayRequest.serialize().
 */
export function parseRequest(buffer: Buffer): RelayRequest {
  const offset = { value: 0 };
  ensureRemaining(buffer, offset.value, 1);
  const type = buffer[offset.value++];
  const connectionId = readString(buffer, offset);

  switch (type) {
    case TYPE_CONNECT: {
      const destIp = readString(buffer, offset);
      ensureRemaining(buffer, offset.value, 2);
      const destPort = buffer.readUInt16BE(offset.value);
      offset.value += 2;
      return { type: "connect", connectionId, destIp, destPort };
    }
    case TYPE_DATA: {
      const payload = readBytes(buffer, offset);
      return { type: "data", connectionId, payload: payload.toString("base64") };
    }
    case TYPE_DISCONNECT:
      return { type: "disconnect", connectionId };
    case TYPE_SHUTDOWN_WRITE:
      return { type: "shutdown_write", connectionId };
    default:
      throw new Error(`Protocol: unknown request type ${type}`);
  }
}

/**
 * Serialize a relay response (AppBack → AppOne).
 * Format must match Kotlin RelayResponse.serialize() byte-for-byte.
 */
export function serializeResponse(response: RelayResponse): Buffer {
  const idBytes = Buffer.from(response.connectionId, "utf-8");
  const idLen = idBytes.length;

  switch (response.type) {
    case "connected": {
      const buf = Buffer.alloc(1 + 2 + idLen);
      let off = 0;
      buf[off++] = TYPE_CONNECTED;
      buf.writeUInt16BE(idLen, off);
      off += 2;
      idBytes.copy(buf, off);
      return buf;
    }
    case "data": {
      const payload = Buffer.from(response.payload, "base64");
      const payloadLen = payload.length;
      const buf = Buffer.alloc(1 + 2 + idLen + 4 + payloadLen);
      let off = 0;
      buf[off++] = TYPE_DATA;
      buf.writeUInt16BE(idLen, off);
      off += 2;
      idBytes.copy(buf, off);
      off += idLen;
      buf.writeUInt32BE(payloadLen, off);
      off += 4;
      payload.copy(buf, off);
      return buf;
    }
    case "disconnected": {
      const buf = Buffer.alloc(1 + 2 + idLen);
      let off = 0;
      buf[off++] = TYPE_DISCONNECTED;
      buf.writeUInt16BE(idLen, off);
      off += 2;
      idBytes.copy(buf, off);
      return buf;
    }
    case "error": {
      const msgBytes = Buffer.from(response.message, "utf-8");
      const msgLen = msgBytes.length;
      const buf = Buffer.alloc(1 + 2 + idLen + 2 + msgLen);
      let off = 0;
      buf[off++] = TYPE_ERROR;
      buf.writeUInt16BE(idLen, off);
      off += 2;
      idBytes.copy(buf, off);
      off += idLen;
      buf.writeUInt16BE(msgLen, off);
      off += 2;
      msgBytes.copy(buf, off);
      return buf;
    }
    default:
      throw new Error(`Protocol: unknown response type`);
  }
}
