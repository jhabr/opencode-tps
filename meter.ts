/**
 * Rate maths for the readout. Fed character counts and a clock, returns rates; it
 * has no UI dependency and no knowledge of opencode. The sampling loop that drives
 * it lives in tps-ui.tsx.
 *
 * Token counts are 0 until a message completes, so the decode figure is live but
 * estimated: characters divided by charsPerToken, which starts at a generic 4 and
 * is recalibrated from the exact token count the provider reports on completion.
 *
 * Prefill is the prompt size divided by time to first token. A prefill *rate*
 * cannot exist before the first token lands, because the first token is what ends
 * prefill, and the provider only reports token counts once the whole message
 * completes. So the caller predicts the prompt size and passes it as a thunk,
 * evaluated only on the tick where the first token appears. The prediction is
 * replaced by the exact figure on completion, which `prefillExact` reports.
 */

const WINDOW_MS = 5000
const MIN_SPAN_MS = 700
const IDLE_GAP_MS = 1500
const STALL_HOLD_MS = 15000
const MAX_STREAM_GAP_MS = 5000
const INITIAL_CHARS_PER_TOKEN = 4
const MIN_CHARS_PER_TOKEN = 1.2
const MAX_CHARS_PER_TOKEN = 12
/** Weight given to the newest chars-per-token observation when recalibrating. */
const CALIBRATION_WEIGHT = 0.3
/** Below this, time to first token is indistinguishable from measurement noise. */
const MIN_TTFT_MS = 50
/** Below this, a decode rate would divide by a span too short to mean anything. */
const MIN_DECODE_SECONDS = 0.05

type Sample = { time: number; chars: number }

type Stream = {
  messageID: string
  chars: number
  activeMs: number
  lastGrowthAt: number
  lastSampleAt: number
  createdAt: number
  ttftMs?: number
}

/** Tokens over time to first token, or undefined when either is below the noise floor. */
const prefillRate = (tokens: number, ttftMs: number | undefined) => {
  if (!ttftMs || ttftMs <= MIN_TTFT_MS || tokens <= 0) return undefined
  return tokens / (ttftMs / 1000)
}

export type TpsMeter = ReturnType<typeof createTpsMeter>

/** UI-free rate tracker, kept separate so it can be driven without a renderer. */
export function createTpsMeter(now: () => number = Date.now) {
  let samples: Sample[] = []
  let stream: Stream | undefined
  let charsPerToken = INITIAL_CHARS_PER_TOKEN
  let live: number | undefined
  let finalDecode: number | undefined
  let finalPrefill: number | undefined
  let estimatedPrefill: number | undefined
  let lastTtftMs: number | undefined

  /**
   * Feed the cumulative character count of the assistant message being generated.
   *
   * `busy` is the session's own status: while it is true a plateau means the TUI
   * state is lagging behind the model, not that generation has stopped.
   *
   * `predictPromptTokens` is read on one tick per message, the one where the first
   * token lands, so the caller passes a thunk rather than paying for the prediction
   * on every tick.
   */
  const sample = ({
    messageID,
    chars,
    busy,
    createdAt,
    predictPromptTokens,
  }: {
    messageID: string
    chars: number
    busy: boolean
    createdAt: number
    predictPromptTokens: () => number
  }) => {
    const time = now()
    let current = stream
    if (!current || current.messageID !== messageID) {
      samples = []
      current = { messageID, chars, activeMs: 0, lastGrowthAt: time, lastSampleAt: time, createdAt }
      stream = current
      finalDecode = undefined
      finalPrefill = undefined
      estimatedPrefill = undefined
      live = undefined
    }

    if (chars > current.chars) {
      if (current.ttftMs === undefined && chars > 0) {
        current.ttftMs = time - current.createdAt
        // Prefill just ended: show a rate now rather than waiting for decode to finish.
        // The guard stays outside so the thunk is only evaluated when a rate can exist.
        if (current.ttftMs > MIN_TTFT_MS) {
          estimatedPrefill = prefillRate(predictPromptTokens(), current.ttftMs)
        }
      }
      current.activeMs += Math.min(time - current.lastSampleAt, MAX_STREAM_GAP_MS)
      current.lastGrowthAt = time
      current.chars = chars
    }
    current.lastSampleAt = time

    // The window is a queue and only its oldest entry is ever read, so expired
    // samples are always a prefix.
    samples.push({ time, chars })
    while (samples.length && time - samples[0].time > WINDOW_MS) samples.shift()

    const sinceGrowth = time - current.lastGrowthAt
    if (sinceGrowth > (busy ? STALL_HOLD_MS : IDLE_GAP_MS)) {
      live = undefined
      return
    }
    // Text has plateaued but the model is still working: keep the last rate on
    // screen rather than recomputing it from a window that is going stale.
    if (sinceGrowth > IDLE_GAP_MS) return
    if (samples.length < 2) return

    const oldest = samples[0]
    const span = time - oldest.time
    const grown = chars - oldest.chars
    if (span < MIN_SPAN_MS || grown <= 0) return
    live = grown / charsPerToken / (span / 1000)
  }

  /** Called once the provider has reported exact token counts for a message. */
  const complete = ({
    messageID,
    outputTokens,
    prefilledTokens,
  }: {
    messageID: string
    outputTokens: number
    prefilledTokens: number
  }) => {
    if (!stream || stream.messageID !== messageID) return
    if (outputTokens > 0) {
      if (stream.chars > 0) {
        const ratio = stream.chars / outputTokens
        if (ratio >= MIN_CHARS_PER_TOKEN && ratio <= MAX_CHARS_PER_TOKEN) {
          charsPerToken = charsPerToken * (1 - CALIBRATION_WEIGHT) + ratio * CALIBRATION_WEIGHT
        }
      }
      const seconds = stream.activeMs / 1000
      if (seconds > MIN_DECODE_SECONDS) finalDecode = outputTokens / seconds
    }
    finalPrefill = prefillRate(prefilledTokens, stream.ttftMs)
    lastTtftMs = stream.ttftMs
    estimatedPrefill = undefined
    stream = undefined
    samples = []
    live = undefined
  }

  /** Seconds spent prefilling so far, while no output has been seen yet. */
  const prefillElapsed = () => {
    if (!stream || stream.ttftMs !== undefined) return undefined
    return (now() - stream.createdAt) / 1000
  }

  return {
    sample,
    complete,
    /** Convert characters to tokens at the current calibration. */
    tokensFromChars: (chars: number) => chars / charsPerToken,
    get prefillElapsed() {
      return prefillElapsed()
    },
    /** Whether this meter has anything to report: decoding, or still prefilling. */
    get active() {
      return live !== undefined || prefillElapsed() !== undefined
    },
    get live() {
      return live
    },
    get finalDecode() {
      return finalDecode
    },
    /** Decode rate: the live estimate while streaming, the exact figure after. */
    get decode() {
      return live ?? finalDecode
    },
    get decodeExact() {
      return live === undefined && finalDecode !== undefined
    },
    /** Prefill rate: exact once the provider reports, predicted before that. */
    get prefill() {
      return finalPrefill ?? estimatedPrefill
    },
    get prefillExact() {
      return finalPrefill !== undefined
    },
    /** Time to first token in seconds, for the current or most recent message. */
    get ttftSeconds() {
      const ms = stream?.ttftMs ?? lastTtftMs
      return ms === undefined ? undefined : ms / 1000
    },
  }
}
