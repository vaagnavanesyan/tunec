const { TAG_TYPE_AUDIO, TAG_TYPE_VIDEO, TAG_TYPE_SCRIPT } = require("./flv-reader");

function createPipeline(...transforms) {
  return (tag) => {
    let result = tag;
    for (const fn of transforms) {
      if (result === null) return null;
      result = fn(result);
    }
    return result;
  };
}

// --- Built-in Transforms ---

/** Multiply all timestamps by a speed factor (e.g. 0.5 = 2x slower, 2.0 = 2x faster) */
function timeScale(factor) {
  return (tag) => ({
    ...tag,
    timestamp: Math.round(tag.timestamp / factor),
  });
}

/** Offset all timestamps by a fixed amount in ms */
function timeShift(offsetMs) {
  return (tag) => ({
    ...tag,
    timestamp: Math.max(0, tag.timestamp + offsetMs),
  });
}

/** Drop all audio tags */
function stripAudio() {
  return (tag) => (tag.type === TAG_TYPE_AUDIO ? null : tag);
}

/** Drop all video tags */
function stripVideo() {
  return (tag) => (tag.type === TAG_TYPE_VIDEO ? null : tag);
}

/** Log tag info without modifying it */
function tapLog(prefix = "TAG") {
  const typeNames = { [TAG_TYPE_AUDIO]: "audio", [TAG_TYPE_VIDEO]: "video", [TAG_TYPE_SCRIPT]: "script" };
  return (tag) => {
    console.log(
      `[${prefix}] ${typeNames[tag.type] || tag.type} ts=${tag.timestamp}ms size=${tag.data.length}b`
    );
    return tag;
  };
}

/** Apply a custom function to the raw data buffer of each tag */
function mapData(fn) {
  return (tag) => ({ ...tag, data: fn(tag.data, tag) });
}

/** Apply a transform only to tags of a specific type */
function forType(type, transform) {
  return (tag) => (tag.type === type ? transform(tag) : tag);
}

module.exports = {
  createPipeline,
  timeScale,
  timeShift,
  stripAudio,
  stripVideo,
  tapLog,
  mapData,
  forType,
};
