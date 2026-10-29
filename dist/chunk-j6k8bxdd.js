// @bun
// meter.ts
var WINDOW_MS = 5000;
var MIN_SPAN_MS = 700;
var IDLE_GAP_MS = 1500;
var STALL_HOLD_MS = 15000;
var MAX_STREAM_GAP_MS = 5000;
var INITIAL_CHARS_PER_TOKEN = 4;
var MIN_CHARS_PER_TOKEN = 1.2;
var MAX_CHARS_PER_TOKEN = 12;
var CALIBRATION_WEIGHT = 0.3;
var MIN_TTFT_MS = 50;
var MIN_DECODE_SECONDS = 0.05;
var prefillRate = (tokens, ttftMs) => {
  if (!ttftMs || ttftMs <= MIN_TTFT_MS || tokens <= 0)
    return;
  return tokens / (ttftMs / 1000);
};
function createTpsMeter(now = Date.now) {
  let samples = [];
  let stream;
  let charsPerToken = INITIAL_CHARS_PER_TOKEN;
  let live;
  let finalDecode;
  let finalPrefill;
  let estimatedPrefill;
  let lastTtftMs;
  const sample = ({
    messageID,
    chars,
    busy,
    createdAt,
    predictPromptTokens
  }) => {
    const time = now();
    let current = stream;
    if (!current || current.messageID !== messageID) {
      samples = [];
      current = { messageID, chars, activeMs: 0, lastGrowthAt: time, lastSampleAt: time, createdAt, busy };
      stream = current;
      finalDecode = undefined;
      finalPrefill = undefined;
      estimatedPrefill = undefined;
      live = undefined;
    }
    if (chars > current.chars) {
      if (current.ttftMs === undefined && chars > 0) {
        current.ttftMs = time - current.createdAt;
        if (current.ttftMs > MIN_TTFT_MS) {
          estimatedPrefill = prefillRate(predictPromptTokens(), current.ttftMs);
        }
      }
      current.activeMs += Math.min(time - current.lastSampleAt, MAX_STREAM_GAP_MS);
      current.lastGrowthAt = time;
      current.chars = chars;
    }
    current.lastSampleAt = time;
    current.busy = busy;
    samples.push({ time, chars });
    while (samples.length && time - samples[0].time > WINDOW_MS)
      samples.shift();
    const sinceGrowth = time - current.lastGrowthAt;
    if (sinceGrowth > (busy ? STALL_HOLD_MS : IDLE_GAP_MS)) {
      live = undefined;
      return;
    }
    if (sinceGrowth > IDLE_GAP_MS)
      return;
    if (samples.length < 2)
      return;
    const oldest = samples[0];
    const span = time - oldest.time;
    const grown = chars - oldest.chars;
    if (span < MIN_SPAN_MS || grown <= 0)
      return;
    live = grown / charsPerToken / (span / 1000);
  };
  const endStream = () => {
    estimatedPrefill = undefined;
    stream = undefined;
    samples = [];
    live = undefined;
  };
  const complete = ({
    messageID,
    outputTokens,
    prefilledTokens
  }) => {
    if (!stream)
      return;
    if (stream.messageID !== messageID) {
      endStream();
      return;
    }
    if (outputTokens > 0) {
      if (stream.chars > 0) {
        const ratio = stream.chars / outputTokens;
        if (ratio >= MIN_CHARS_PER_TOKEN && ratio <= MAX_CHARS_PER_TOKEN) {
          charsPerToken = charsPerToken * (1 - CALIBRATION_WEIGHT) + ratio * CALIBRATION_WEIGHT;
        }
      }
      const seconds = stream.activeMs / 1000;
      if (seconds > MIN_DECODE_SECONDS)
        finalDecode = outputTokens / seconds;
    }
    finalPrefill = prefillRate(prefilledTokens, stream.ttftMs);
    lastTtftMs = stream.ttftMs;
    endStream();
  };
  const prefillElapsed = () => {
    if (!stream || !stream.busy || stream.ttftMs !== undefined)
      return;
    return (now() - stream.createdAt) / 1000;
  };
  return {
    sample,
    complete,
    tokensFromChars: (chars) => chars / charsPerToken,
    get prefillElapsed() {
      return prefillElapsed();
    },
    get active() {
      return live !== undefined || prefillElapsed() !== undefined;
    },
    get live() {
      return live;
    },
    get finalDecode() {
      return finalDecode;
    },
    get decode() {
      return live ?? finalDecode;
    },
    get decodeExact() {
      return live === undefined && finalDecode !== undefined;
    },
    get prefill() {
      return finalPrefill ?? estimatedPrefill;
    },
    get prefillExact() {
      return finalPrefill !== undefined;
    },
    get ttftSeconds() {
      const ms = stream?.ttftMs ?? lastTtftMs;
      return ms === undefined ? undefined : ms / 1000;
    }
  };
}

// readout.ts
var TICK_MS = 200;
var MAX_TRACKED_SESSIONS = 32;
var FAST_DECODE = 50;
var OK_DECODE = 25;
var FAST_PREFILL = 2000;
var OK_PREFILL = 500;
var FAST_COLOUR = "#3fb950";
var OK_COLOUR = "#e3861b";
var SLOW_COLOUR = "#f85149";
var format = (rate) => {
  if (rate >= 1000)
    return `${(rate / 1000).toFixed(1)}k`;
  if (rate >= 100)
    return rate.toFixed(0);
  return rate.toFixed(1);
};
var band = (rate, fast, ok) => rate >= fast ? FAST_COLOUR : rate >= ok ? OK_COLOUR : SLOW_COLOUR;
var generatedTokens = (tokens) => (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
var contributors = (own, descendants) => {
  if (own?.active)
    return [own];
  const active = descendants.filter((meter) => meter?.active === true);
  return active.length ? active : own ? [own] : [];
};
var needsSample = (busy, meter) => busy || meter?.active === true;
var longestWait = (values, muted) => {
  const defined = values.filter((value) => value !== undefined);
  if (!defined.length)
    return [];
  return [[`\u2191 ${Math.max(...defined).toFixed(1)}s`, muted]];
};
var segments = (active, muted) => {
  if (!active.length)
    return [];
  const decoding = active.filter((meter) => meter.live !== undefined);
  if (!decoding.length) {
    const waiting = longestWait(active.map((meter) => meter.prefillElapsed), muted);
    if (waiting.length)
      return waiting;
  }
  const parts = [];
  const reporting = decoding.length ? decoding : active;
  let prefillTotal = 0;
  let prefillKnown = false;
  let prefillExact = true;
  let decodeTotal = 0;
  let decodeKnown = false;
  let decodeExact = true;
  for (const meter of reporting) {
    const prefill = meter.prefill;
    if (prefill !== undefined) {
      prefillTotal += prefill;
      prefillKnown = true;
      if (!meter.prefillExact)
        prefillExact = false;
    }
    const decode = meter.decode;
    if (decode !== undefined) {
      decodeTotal += decode;
      decodeKnown = true;
      if (!meter.decodeExact)
        decodeExact = false;
    }
  }
  if (prefillKnown) {
    parts.push([
      `\u2191 ${prefillExact ? "" : "~"}${format(prefillTotal)} tok/s`,
      band(prefillTotal, FAST_PREFILL, OK_PREFILL)
    ]);
  } else {
    parts.push(...longestWait(reporting.map((meter) => meter.ttftSeconds), muted));
  }
  if (decodeKnown) {
    parts.push([`\u2193 ${decodeExact ? "" : "~"}${format(decodeTotal)} tok/s`, band(decodeTotal, FAST_DECODE, OK_DECODE)]);
  }
  const joined = parts.flatMap((part, index) => index ? [[" \xB7 ", muted], part] : [part]);
  if (joined.length && reporting.length > 1)
    joined.push([` (${reporting.length} agents)`, muted]);
  return joined;
};

export { createTpsMeter, TICK_MS, MAX_TRACKED_SESSIONS, generatedTokens, contributors, needsSample, segments };
