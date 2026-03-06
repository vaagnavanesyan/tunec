const zlib = require("zlib");

const MAGIC = Buffer.from("STEG");
const Q = 32;
const HALF_Q = Q / 2;
const QUARTER_Q = Q / 4;
const BLOCK = 8;
const REPS = 3;
const UTILIZATION = 0.9;
// MAGIC(4) + chunk_index(2) + total_chunks(2) + chunk_data_length(4)
const HEADER_BYTES = 4 + 2 + 2 + 4;
const CRC_BYTES = 4;
const FRAME_OVERHEAD = HEADER_BYTES + CRC_BYTES;

// --- BMP helpers ---

function parseBmpHeader(buf) {
  const sig = buf.toString("ascii", 0, 2);
  if (sig !== "BM") throw new Error(`Not a BMP file (sig: ${sig})`);

  const pixelOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  if (bpp !== 24) throw new Error(`Only 24-bit BMP supported, got ${bpp}`);
  if (compression !== 0) throw new Error("Only uncompressed BMP supported");

  const absHeight = Math.abs(height);
  const topDown = height < 0;
  const rowPad = (4 - ((width * 3) % 4)) % 4;
  const rowStride = width * 3 + rowPad;

  return { pixelOffset, width, height: absHeight, topDown, rowStride };
}

function greenByteOffset(hdr, x, y) {
  const fileRow = hdr.topDown ? y : hdr.height - 1 - y;
  return hdr.pixelOffset + fileRow * hdr.rowStride + x * 3 + 1;
}

// --- CRC32 ---

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Bit conversion ---

function toBits(buf) {
  const bits = new Uint8Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 7; b >= 0; b--) {
      bits[i * 8 + (7 - b)] = (buf[i] >> b) & 1;
    }
  }
  return bits;
}

function fromBits(bits, length) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length * 8 && i < bits.length; i++) {
    if (bits[i]) buf[i >> 3] |= 1 << (7 - (i & 7));
  }
  return buf;
}

// --- QIM core ---

function qimEncode(v, bit) {
  const q = bit === 0
    ? Math.round(v / Q) * Q
    : Math.round((v - HALF_Q) / Q) * Q + HALF_Q;
  return Math.max(0, Math.min(255, q));
}

function qimDecode(v) {
  const r = ((v % Q) + Q) % Q;
  return (r >= QUARTER_Q && r < Q - QUARTER_Q) ? 1 : 0;
}

// --- Public API ---

function maxPayload(bmpBuffer) {
  const hdr = parseBmpHeader(bmpBuffer);
  const bCols = Math.floor(hdr.width / BLOCK);
  const bRows = Math.floor(hdr.height / BLOCK);
  const usableBlocks = Math.floor(bCols * bRows * UTILIZATION);
  return Math.floor(usableBlocks / REPS / 8) - FRAME_OVERHEAD;
}

function embedChunk(bmpBuffer, chunkData, chunkIndex, totalChunks) {
  const buf = Buffer.from(bmpBuffer);
  const hdr = parseBmpHeader(buf);

  const bCols = Math.floor(hdr.width / BLOCK);
  const bRows = Math.floor(hdr.height / BLOCK);
  const totalBlocks = bCols * bRows;

  const frame = Buffer.alloc(FRAME_OVERHEAD + chunkData.length);
  MAGIC.copy(frame, 0);
  frame.writeUInt16LE(chunkIndex, 4);
  frame.writeUInt16LE(totalChunks, 6);
  frame.writeUInt32LE(chunkData.length, 8);
  chunkData.copy(frame, HEADER_BYTES);
  frame.writeUInt32LE(crc32(chunkData), HEADER_BYTES + chunkData.length);

  const bits = toBits(frame);
  const needed = bits.length * REPS;

  if (needed > totalBlocks) {
    const max = Math.floor(totalBlocks / REPS / 8) - FRAME_OVERHEAD;
    throw new Error(
      `Chunk too large: need ${needed} blocks, have ${totalBlocks} (max ~${max} bytes)`
    );
  }

  let blockIdx = 0;
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i];
    for (let r = 0; r < REPS; r++, blockIdx++) {
      const bx = blockIdx % bCols;
      const by = Math.floor(blockIdx / bCols);
      for (let dy = 0; dy < BLOCK; dy++) {
        for (let dx = 0; dx < BLOCK; dx++) {
          const off = greenByteOffset(hdr, bx * BLOCK + dx, by * BLOCK + dy);
          buf[off] = qimEncode(buf[off], bit);
        }
      }
    }
  }

  return buf;
}

function extractChunk(bmpBuffer) {
  const hdr = parseBmpHeader(bmpBuffer);

  const bCols = Math.floor(hdr.width / BLOCK);
  const bRows = Math.floor(hdr.height / BLOCK);
  const totalBlocks = bCols * bRows;

  function readBlockBit(blockIdx) {
    const bx = blockIdx % bCols;
    const by = Math.floor(blockIdx / bCols);
    let ones = 0;
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const off = greenByteOffset(hdr, bx * BLOCK + dx, by * BLOCK + dy);
        if (qimDecode(bmpBuffer[off])) ones++;
      }
    }
    return ones > (BLOCK * BLOCK) / 2 ? 1 : 0;
  }

  function decodeBit(bitIndex) {
    let ones = 0;
    const base = bitIndex * REPS;
    for (let r = 0; r < REPS; r++) {
      if (readBlockBit(base + r)) ones++;
    }
    return ones > REPS / 2 ? 1 : 0;
  }

  const headerBitCount = HEADER_BYTES * 8;
  const headerNeeded = headerBitCount * REPS;
  if (totalBlocks < headerNeeded) throw new Error("Image too small for stego header");

  const headerBits = new Uint8Array(headerBitCount);
  for (let i = 0; i < headerBitCount; i++) headerBits[i] = decodeBit(i);
  const headerBuf = fromBits(headerBits, HEADER_BYTES);

  if (!headerBuf.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`No stego message found (magic: 0x${headerBuf.subarray(0, 4).toString("hex")})`);
  }

  const chunkIndex = headerBuf.readUInt16LE(4);
  const totalChunks = headerBuf.readUInt16LE(6);
  const chunkLen = headerBuf.readUInt32LE(8);

  const frameBytesTotal = FRAME_OVERHEAD + chunkLen;
  const frameBitCount = frameBytesTotal * 8;
  const frameNeeded = frameBitCount * REPS;

  if (totalBlocks < frameNeeded) {
    throw new Error(`Chunk claims ${chunkLen} bytes but not enough blocks`);
  }

  const frameBits = new Uint8Array(frameBitCount);
  for (let i = 0; i < headerBitCount; i++) frameBits[i] = headerBits[i];
  for (let i = headerBitCount; i < frameBitCount; i++) frameBits[i] = decodeBit(i);
  const frameBuf = fromBits(frameBits, frameBytesTotal);

  const data = frameBuf.subarray(HEADER_BYTES, HEADER_BYTES + chunkLen);
  const storedCrc = frameBuf.readUInt32LE(HEADER_BYTES + chunkLen);
  const actualCrc = crc32(data);

  if (storedCrc !== actualCrc) {
    throw new Error(
      `CRC mismatch on chunk ${chunkIndex}: stored=0x${storedCrc.toString(16)}, actual=0x${actualCrc.toString(16)}`
    );
  }

  return { chunkIndex, totalChunks, data };
}

function prepareChunks(bmpBuffer, messageBuffer) {
  const cap = maxPayload(bmpBuffer);
  if (cap <= 0) throw new Error("Image too small for any stego payload");

  const totalChunks = Math.ceil(messageBuffer.length / cap);
  console.log(
    `Splitting ${messageBuffer.length}B message into ${totalChunks} chunk(s), ` +
    `max ${cap}B per frame`
  );

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * cap;
    const end = Math.min(start + cap, messageBuffer.length);
    chunks.push(messageBuffer.subarray(start, end));
  }
  return { chunks, totalChunks };
}

function reassembleChunks(chunksMap) {
  const indices = Array.from(chunksMap.keys()).sort((a, b) => a - b);
  const parts = indices.map((i) => chunksMap.get(i));
  return Buffer.concat(parts);
}

module.exports = {
  maxPayload,
  embedChunk,
  extractChunk,
  prepareChunks,
  reassembleChunks,
};
