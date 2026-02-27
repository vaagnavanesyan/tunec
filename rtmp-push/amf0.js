const AMF0_NUMBER = 0x00;
const AMF0_BOOLEAN = 0x01;
const AMF0_STRING = 0x02;
const AMF0_OBJECT = 0x03;
const AMF0_NULL = 0x05;
const AMF0_ECMA_ARRAY = 0x08;
const AMF0_OBJECT_END = 0x09;

// --- Encoder ---

function encodeNumber(value) {
  const buf = Buffer.alloc(9);
  buf[0] = AMF0_NUMBER;
  buf.writeDoubleBE(value, 1);
  return buf;
}

function encodeBoolean(value) {
  const buf = Buffer.alloc(2);
  buf[0] = AMF0_BOOLEAN;
  buf[1] = value ? 1 : 0;
  return buf;
}

function encodeString(value) {
  const strBuf = Buffer.from(value, "utf8");
  const buf = Buffer.alloc(3 + strBuf.length);
  buf[0] = AMF0_STRING;
  buf.writeUInt16BE(strBuf.length, 1);
  strBuf.copy(buf, 3);
  return buf;
}

function encodeObjectProperty(key, value) {
  const keyBuf = Buffer.from(key, "utf8");
  const header = Buffer.alloc(2);
  header.writeUInt16BE(keyBuf.length, 0);
  return Buffer.concat([header, keyBuf, encodeValue(value)]);
}

function encodeObject(obj) {
  const parts = [Buffer.from([AMF0_OBJECT])];
  for (const [key, value] of Object.entries(obj)) {
    parts.push(encodeObjectProperty(key, value));
  }
  parts.push(Buffer.from([0x00, 0x00, AMF0_OBJECT_END]));
  return Buffer.concat(parts);
}

function encodeNull() {
  return Buffer.from([AMF0_NULL]);
}

function encodeValue(value) {
  if (value === null || value === undefined) return encodeNull();
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "boolean") return encodeBoolean(value);
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "object") return encodeObject(value);
  throw new Error(`Unsupported AMF0 type: ${typeof value}`);
}

function encode(...values) {
  return Buffer.concat(values.map(encodeValue));
}

// --- Decoder ---

function decodeValue(buf, offset) {
  const marker = buf[offset];
  offset += 1;

  switch (marker) {
    case AMF0_NUMBER: {
      const value = buf.readDoubleBE(offset);
      return { value, offset: offset + 8 };
    }
    case AMF0_BOOLEAN: {
      const value = buf[offset] !== 0;
      return { value, offset: offset + 1 };
    }
    case AMF0_STRING: {
      const len = buf.readUInt16BE(offset);
      const value = buf.toString("utf8", offset + 2, offset + 2 + len);
      return { value, offset: offset + 2 + len };
    }
    case AMF0_OBJECT: {
      const obj = {};
      while (true) {
        const keyLen = buf.readUInt16BE(offset);
        offset += 2;
        if (keyLen === 0 && buf[offset] === AMF0_OBJECT_END) {
          offset += 1;
          break;
        }
        const key = buf.toString("utf8", offset, offset + keyLen);
        offset += keyLen;
        const result = decodeValue(buf, offset);
        obj[key] = result.value;
        offset = result.offset;
      }
      return { value: obj, offset };
    }
    case AMF0_NULL: {
      return { value: null, offset };
    }
    case AMF0_ECMA_ARRAY: {
      // 4-byte count (approximate), then key-value pairs like object
      offset += 4;
      const obj = {};
      while (true) {
        const keyLen = buf.readUInt16BE(offset);
        offset += 2;
        if (keyLen === 0 && buf[offset] === AMF0_OBJECT_END) {
          offset += 1;
          break;
        }
        const key = buf.toString("utf8", offset, offset + keyLen);
        offset += keyLen;
        const result = decodeValue(buf, offset);
        obj[key] = result.value;
        offset = result.offset;
      }
      return { value: obj, offset };
    }
    default:
      throw new Error(`Unknown AMF0 marker: 0x${marker.toString(16)}`);
  }
}

function decode(buf, offset = 0) {
  const values = [];
  while (offset < buf.length) {
    const result = decodeValue(buf, offset);
    values.push(result.value);
    offset = result.offset;
  }
  return values;
}

module.exports = { encode, decode, encodeValue, decodeValue };
