const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const amf0 = require("./amf0");

const RTMP_VERSION = 3;
const HANDSHAKE_SIZE = 1536;
const DEFAULT_CHUNK_SIZE = 128;
const OUT_CHUNK_SIZE = 4096;

// Message type IDs
const MSG_SET_CHUNK_SIZE = 1;
const MSG_ABORT = 2;
const MSG_ACK = 3;
const MSG_USER_CONTROL = 4;
const MSG_WIN_ACK_SIZE = 5;
const MSG_SET_PEER_BW = 6;
const MSG_AUDIO = 8;
const MSG_VIDEO = 9;
const MSG_DATA_AMF0 = 18;
const MSG_CMD_AMF0 = 20;

// Chunk stream IDs
const CSID_PROTOCOL = 2;
const CSID_COMMAND = 3;
const CSID_AUDIO = 4;
const CSID_VIDEO = 6;

const HANDSHAKE_UNINIT = 0;
const HANDSHAKE_SENT_C0C1 = 1;
const HANDSHAKE_SENT_C2 = 2;
const HANDSHAKE_DONE = 3;

class RtmpClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.handshakeState = HANDSHAKE_UNINIT;
    this.inChunkSize = DEFAULT_CHUNK_SIZE;
    this.outChunkSize = DEFAULT_CHUNK_SIZE;
    this.inBuffer = Buffer.alloc(0);
    this.transactionId = 0;
    this.pendingCommands = new Map();
    this.streamId = 0;
    this.chunkHeaders = new Map();
    this.chunkBodies = new Map();
    this.bytesReceived = 0;
    this.windowAckSize = 0;
    this.lastAckSent = 0;
  }

  connect(host, port, app, tcUrl) {
    return new Promise((resolve, reject) => {
      this.app = app;
      this.tcUrl = tcUrl;

      this.socket = net.createConnection({ host, port }, () => {
        this._sendHandshakeC0C1();
      });

      this.socket.on("data", (chunk) => this._onData(chunk));
      this.socket.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      this.socket.on("close", () => this.emit("close"));

      this.once("connected", resolve);
    });
  }

  // --- Handshake ---

  _sendHandshakeC0C1() {
    const c0 = Buffer.from([RTMP_VERSION]);
    const c1 = Buffer.alloc(HANDSHAKE_SIZE);
    c1.writeUInt32BE(0, 0); // timestamp
    c1.writeUInt32BE(0, 4); // zero
    crypto.randomFillSync(c1, 8); // random bytes
    this.c1 = c1;

    this.socket.write(Buffer.concat([c0, c1]));
    this.handshakeState = HANDSHAKE_SENT_C0C1;
  }

  _processHandshake() {
    if (this.handshakeState === HANDSHAKE_SENT_C0C1) {
      // Need S0(1) + S1(1536) + S2(1536) = 3073
      if (this.inBuffer.length < 1 + HANDSHAKE_SIZE * 2) return false;

      const s1 = this.inBuffer.subarray(1, 1 + HANDSHAKE_SIZE);

      // Send C2 = echo of S1
      const c2 = Buffer.alloc(HANDSHAKE_SIZE);
      s1.copy(c2);
      this.socket.write(c2);

      this.inBuffer = this.inBuffer.subarray(1 + HANDSHAKE_SIZE * 2);
      this.handshakeState = HANDSHAKE_DONE;

      this._postHandshake();
      return true;
    }
    return false;
  }

  async _postHandshake() {
    this._sendSetChunkSize(OUT_CHUNK_SIZE);
    this.outChunkSize = OUT_CHUNK_SIZE;

    await this._sendConnect();
    this.emit("connected");
  }

  // --- Data Receiving ---

  _onData(chunk) {
    this.inBuffer = Buffer.concat([this.inBuffer, chunk]);
    this.bytesReceived += chunk.length;

    if (this.handshakeState !== HANDSHAKE_DONE) {
      this._processHandshake();
      if (this.handshakeState !== HANDSHAKE_DONE) return;
    }

    this._processChunks();
  }

  _processChunks() {
    while (this.inBuffer.length > 0) {
      const result = this._readChunk();
      if (!result) break;
    }
  }

  _readChunk() {
    if (this.inBuffer.length < 1) return null;

    const fmt = (this.inBuffer[0] >> 6) & 0x03;
    let csid = this.inBuffer[0] & 0x3f;
    let headerOffset = 1;

    if (csid === 0) {
      if (this.inBuffer.length < 2) return null;
      csid = this.inBuffer[1] + 64;
      headerOffset = 2;
    } else if (csid === 1) {
      if (this.inBuffer.length < 3) return null;
      csid = (this.inBuffer[2] << 8) + this.inBuffer[1] + 64;
      headerOffset = 3;
    }

    const msgHeaderSizes = [11, 7, 3, 0];
    const msgHeaderSize = msgHeaderSizes[fmt];
    const totalHeaderSize = headerOffset + msgHeaderSize;

    if (this.inBuffer.length < totalHeaderSize) return null;

    let prev = this.chunkHeaders.get(csid) || {
      timestamp: 0,
      messageLength: 0,
      messageTypeId: 0,
      messageStreamId: 0,
    };

    let timestamp = prev.timestamp;
    let messageLength = prev.messageLength;
    let messageTypeId = prev.messageTypeId;
    let messageStreamId = prev.messageStreamId;

    const hdr = this.inBuffer;
    const o = headerOffset;

    if (fmt <= 2) {
      const ts = (hdr[o] << 16) | (hdr[o + 1] << 8) | hdr[o + 2];
      if (fmt === 0) {
        timestamp = ts;
      } else {
        timestamp = prev.timestamp + ts;
      }
    }
    if (fmt <= 1) {
      messageLength = (hdr[o + 3] << 16) | (hdr[o + 4] << 8) | hdr[o + 5];
      messageTypeId = hdr[o + 6];
    }
    if (fmt === 0) {
      messageStreamId = hdr.readUInt32LE(o + 7);
    }

    // Extended timestamp
    let extTimestampSize = 0;
    if (fmt <= 2) {
      const tsField = (hdr[o] << 16) | (hdr[o + 1] << 8) | hdr[o + 2];
      if (tsField === 0xffffff) {
        if (this.inBuffer.length < totalHeaderSize + 4) return null;
        timestamp = this.inBuffer.readUInt32BE(totalHeaderSize);
        extTimestampSize = 4;
      }
    }

    this.chunkHeaders.set(csid, {
      timestamp,
      messageLength,
      messageTypeId,
      messageStreamId,
    });

    // Read chunk body
    const bodyKey = csid;
    let accumulated = this.chunkBodies.get(bodyKey) || Buffer.alloc(0);
    const remaining = messageLength - accumulated.length;
    const chunkDataSize = Math.min(remaining, this.inChunkSize);
    const fullSize = totalHeaderSize + extTimestampSize + chunkDataSize;

    if (this.inBuffer.length < fullSize) return null;

    const chunkData = this.inBuffer.subarray(
      totalHeaderSize + extTimestampSize,
      fullSize
    );
    accumulated = Buffer.concat([accumulated, chunkData]);
    this.inBuffer = this.inBuffer.subarray(fullSize);

    if (accumulated.length >= messageLength) {
      this.chunkBodies.delete(bodyKey);
      this._handleMessage(
        messageTypeId,
        accumulated,
        messageStreamId,
        timestamp
      );
    } else {
      this.chunkBodies.set(bodyKey, accumulated);
    }

    this._maybeSendAck();
    return true;
  }

  _maybeSendAck() {
    if (
      this.windowAckSize > 0 &&
      this.bytesReceived - this.lastAckSent >= this.windowAckSize
    ) {
      this._sendAck(this.bytesReceived);
      this.lastAckSent = this.bytesReceived;
    }
  }

  // --- Message Handling ---

  _handleMessage(typeId, data, streamId, timestamp) {
    switch (typeId) {
      case MSG_SET_CHUNK_SIZE:
        this.inChunkSize = data.readUInt32BE(0) & 0x7fffffff;
        break;
      case MSG_WIN_ACK_SIZE:
        this.windowAckSize = data.readUInt32BE(0);
        break;
      case MSG_SET_PEER_BW:
        this._sendWindowAckSize(this.windowAckSize || data.readUInt32BE(0));
        break;
      case MSG_CMD_AMF0:
        this._handleCommand(data);
        break;
      case MSG_USER_CONTROL:
        this._handleUserControl(data);
        break;
      case MSG_ACK:
      case MSG_ABORT:
        break;
      default:
        break;
    }
  }

  _handleCommand(data) {
    const args = amf0.decode(data);
    const name = args[0];
    const txId = args[1];

    if (name === "_result" || name === "_error") {
      const pending = this.pendingCommands.get(txId);
      if (pending) {
        this.pendingCommands.delete(txId);
        if (name === "_error") {
          pending.reject(new Error(JSON.stringify(args)));
        } else {
          pending.resolve(args);
        }
      }
    } else if (name === "onStatus") {
      this.emit("status", args);
    }
  }

  _handleUserControl(data) {
    const eventType = data.readUInt16BE(0);
    // Ping request -> send pong
    if (eventType === 6) {
      const timestamp = data.readUInt32BE(2);
      this._sendUserControl(7, timestamp);
    }
  }

  // --- Chunk Writing ---

  _writeChunk(csid, typeId, streamId, timestamp, payload) {
    const chunks = [];
    let offset = 0;
    let first = true;

    while (offset < payload.length) {
      const chunkPayloadSize = Math.min(
        payload.length - offset,
        this.outChunkSize
      );

      if (first) {
        // Format 0: full header
        const header = Buffer.alloc(12);
        header[0] = (0 << 6) | (csid & 0x3f);

        const ts = Math.min(timestamp, 0xffffff);
        header[1] = (ts >> 16) & 0xff;
        header[2] = (ts >> 8) & 0xff;
        header[3] = ts & 0xff;

        header[4] = (payload.length >> 16) & 0xff;
        header[5] = (payload.length >> 8) & 0xff;
        header[6] = payload.length & 0xff;

        header[7] = typeId;

        header.writeUInt32LE(streamId, 8);

        chunks.push(header);

        if (timestamp >= 0xffffff) {
          const ext = Buffer.alloc(4);
          ext.writeUInt32BE(timestamp, 0);
          chunks.push(ext);
        }

        first = false;
      } else {
        // Format 3: continuation
        const header = Buffer.alloc(1);
        header[0] = (3 << 6) | (csid & 0x3f);
        chunks.push(header);

        if (timestamp >= 0xffffff) {
          const ext = Buffer.alloc(4);
          ext.writeUInt32BE(timestamp, 0);
          chunks.push(ext);
        }
      }

      chunks.push(payload.subarray(offset, offset + chunkPayloadSize));
      offset += chunkPayloadSize;
    }

    const fullBuf = Buffer.concat(chunks);
    this.socket.write(fullBuf);
  }

  // --- Protocol Control Messages ---

  _sendSetChunkSize(size) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(size, 0);
    this._writeChunk(CSID_PROTOCOL, MSG_SET_CHUNK_SIZE, 0, 0, payload);
  }

  _sendAck(sequenceNumber) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(sequenceNumber, 0);
    this._writeChunk(CSID_PROTOCOL, MSG_ACK, 0, 0, payload);
  }

  _sendWindowAckSize(size) {
    this.windowAckSize = size;
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(size, 0);
    this._writeChunk(CSID_PROTOCOL, MSG_WIN_ACK_SIZE, 0, 0, payload);
  }

  _sendUserControl(eventType, value) {
    const payload = Buffer.alloc(6);
    payload.writeUInt16BE(eventType, 0);
    payload.writeUInt32BE(value, 2);
    this._writeChunk(CSID_PROTOCOL, MSG_USER_CONTROL, 0, 0, payload);
  }

  // --- RTMP Commands ---

  _sendCommand(csid, streamId, name, txId, cmdObj, ...args) {
    const payload = amf0.encode(name, txId, cmdObj, ...args);
    this._writeChunk(csid, MSG_CMD_AMF0, streamId, 0, payload);
  }

  _invoke(csid, streamId, name, cmdObj, ...args) {
    return new Promise((resolve, reject) => {
      this.transactionId++;
      const txId = this.transactionId;
      this.pendingCommands.set(txId, { resolve, reject });
      this._sendCommand(csid, streamId, name, txId, cmdObj, ...args);
    });
  }

  async _sendConnect() {
    const result = await this._invoke(CSID_COMMAND, 0, "connect", {
      app: this.app,
      type: "nonprivate",
      flashVer: "FMLE/3.0",
      tcUrl: this.tcUrl,
    });
    return result;
  }

  async createStream() {
    const result = await this._invoke(CSID_COMMAND, 0, "createStream", null);
    this.streamId = result[3];
    return this.streamId;
  }

  publish(streamName) {
    this._sendCommand(
      CSID_COMMAND,
      this.streamId,
      "publish",
      0,
      null,
      streamName,
      "live"
    );
  }

  // --- Media Sending ---

  sendMetadata(data) {
    this._writeChunk(CSID_AUDIO, MSG_DATA_AMF0, this.streamId, 0, data);
  }

  sendAudio(timestamp, data) {
    this._writeChunk(CSID_AUDIO, MSG_AUDIO, this.streamId, timestamp, data);
  }

  sendVideo(timestamp, data) {
    this._writeChunk(CSID_VIDEO, MSG_VIDEO, this.streamId, timestamp, data);
  }

  sendTag(tag) {
    switch (tag.type) {
      case MSG_AUDIO:
        this.sendAudio(tag.timestamp, tag.data);
        break;
      case MSG_VIDEO:
        this.sendVideo(tag.timestamp, tag.data);
        break;
      case MSG_DATA_AMF0:
        this.sendMetadata(tag.data);
        break;
    }
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}

module.exports = { RtmpClient };
