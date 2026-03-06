const { toAMF, decodeAMF, Memo } = require("amf-codec");
const { ECMA_ARRAY, OBJECT_END } = require("amf-codec/lib/const");
const { encodeStringValue } = require("amf-codec/lib/types/string");

function encode(...values) {
  return Buffer.concat(values.map(toAMF));
}

function decode(buf, offset = 0) {
  const memo = new Memo(offset);
  const values = [];
  while (memo.position < buf.length) {
    values.push(decodeAMF(buf, memo));
  }
  return values;
}

function encodeValue(value) {
  return toAMF(value);
}

function decodeValue(buf, offset) {
  const memo = new Memo(offset);
  const value = decodeAMF(buf, memo);
  return { value, offset: memo.position };
}

function encodeEcmaArray(obj) {
  const entries = Object.entries(obj);
  const header = Buffer.alloc(5);
  header[0] = ECMA_ARRAY;
  header.writeUInt32BE(entries.length, 1);
  const parts = [header];
  for (const [key, value] of entries) {
    parts.push(...encodeStringValue(key));
    parts.push(toAMF(value));
  }
  parts.push(Buffer.from([0x00, 0x00, OBJECT_END]));
  return Buffer.concat(parts);
}

module.exports = { encode, decode, encodeValue, encodeEcmaArray, decodeValue };
