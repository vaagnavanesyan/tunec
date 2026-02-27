const fs = require("fs");

const TAG_TYPE_AUDIO = 8;
const TAG_TYPE_VIDEO = 9;
const TAG_TYPE_SCRIPT = 18;

const FLV_HEADER_SIZE = 9;
const TAG_HEADER_SIZE = 11;
const PREV_TAG_SIZE_FIELD = 4;

class FlvReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    this.header = null;
  }

  open() {
    this.fd = fs.openSync(this.filePath, "r");
    this.header = this._readHeader();
    // Skip first PreviousTagSize0 (always 0)
    this._readBytes(PREV_TAG_SIZE_FIELD);
    return this.header;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  _readBytes(length) {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(this.fd, buf, 0, length, null);
    if (bytesRead < length) return null;
    return buf;
  }

  _readHeader() {
    const buf = this._readBytes(FLV_HEADER_SIZE);
    if (!buf) throw new Error("Failed to read FLV header");

    const signature = buf.toString("ascii", 0, 3);
    if (signature !== "FLV") {
      throw new Error(`Not an FLV file (signature: ${signature})`);
    }

    return {
      version: buf[3],
      hasAudio: !!(buf[4] & 0x04),
      hasVideo: !!(buf[4] & 0x01),
      dataOffset: buf.readUInt32BE(5),
    };
  }

  readTag() {
    const headerBuf = this._readBytes(TAG_HEADER_SIZE);
    if (!headerBuf) return null;

    const type = headerBuf[0] & 0x1f;
    const dataSize =
      (headerBuf[1] << 16) | (headerBuf[2] << 8) | headerBuf[3];
    const timestamp =
      (headerBuf[4] << 16) |
      (headerBuf[5] << 8) |
      headerBuf[6] |
      (headerBuf[7] << 24); // TimestampExtended is the high 8 bits

    const data = this._readBytes(dataSize);
    if (!data) return null;

    // Skip PreviousTagSize after this tag
    this._readBytes(PREV_TAG_SIZE_FIELD);

    return { type, timestamp, data };
  }

  *tags() {
    let tag;
    while ((tag = this.readTag()) !== null) {
      yield tag;
    }
  }
}

module.exports = {
  FlvReader,
  TAG_TYPE_AUDIO,
  TAG_TYPE_VIDEO,
  TAG_TYPE_SCRIPT,
};
