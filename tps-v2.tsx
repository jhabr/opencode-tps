import type { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { createTpsMeter, type TpsMeter } from "./meter.ts"
import type { Plugin } from "opencode-plugin-v2/tui"

/**
 * Realtime tokens/sec readout for the opencode 2.0 TUI, rendered in the prompt
 * footer's status cluster.
 *
 *   ↑ 2.4s                        prompt is being prefilled, no output token yet
 *   ↓ ~28.6 tok/s                 decoding
 *   ↑ 2.7k tok/s · ↓ 28.6 tok/s   finished: exact prefill and decode rates
 *
 * Registered in ~/.config/opencode/cli.json ("plugins": [...]). The v1 plugin for
 * opencode 1.x lives in tps.ts / tps-ui.tsx; both share meter.ts for the maths.
 *
 * The port in one paragraph
 * -------------------------
 * v2 streams text deltas straight into the client message store, but still reports
 * exact token counts only when a step ends, so the sampling architecture survives
 * unchanged: every 200ms the accumulated text length of the newest assistant
 * message is read and differenced over a sliding window. What changed is the shape
 * of everything around it: messages carry `content` arrays instead of parts,
 * `data.session.family()` replaces hand-tracked parent/child bookkeeping, sessions
 * report "running"/"idle" instead of a busy status object, and the readout is a
 * slot claim on "prompt.footer.status" instead of "session_prompt_right".
 *
 * Per session, and summed
 * -----------------------
 * Every session gets its own meter. On a session that is itself generating the
 * readout speaks for that session alone, so clicking into a subagent shows that
 * agent's rate. On a parent parked on a tool call it speaks for every descendant
 * that is generating, summed and suffixed "(N agents)" - on a single local GPU the
 * aggregate is what matches the server's own throughput.
 */

const TICK_MS = 200
const MAX_TRACKED_SESSIONS = 32

/**
 * Colour bands. Decode boundaries match the Claude Code statusline; prefill runs
 * one to two orders of magnitude faster so it gets its own. Fixed hex rather than
 * theme colours so the bands really do read as green/orange/red on every theme.
 */
const FAST_DECODE = 50
const OK_DECODE = 25
const FAST_PREFILL = 2000
const OK_PREFILL = 500
const FAST_COLOUR = "#3fb950"
const OK_COLOUR = "#e3861b"
const SLOW_COLOUR = "#f85149"

const format = (rate: number) => {
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k`
  if (rate >= 100) return rate.toFixed(0)
  return rate.toFixed(1)
}

const band = (rate: number, fast: number, ok: number) =>
  rate >= fast ? FAST_COLOUR : rate >= ok ? OK_COLOUR : SLOW_COLOUR

const setup = (context: Plugin.Context) => {
  const [version, setVersion] = createSignal(0)

  // One meter per session. A subagent generates in its own child session, so the
  // session that is producing tokens is frequently not the one on screen.
  const meters = new Map<string, TpsMeter>()

  const meterFor = (sessionID: string) => {
    let meter = meters.get(sessionID)
    if (!meter) {
      meter = createTpsMeter()
      meters.set(sessionID, meter)
    }
    return meter
  }

  const isBusy = (sessionID: string) => context.data.session.status(sessionID) === "running"

  /** Is `sessionID` beneath `routed`? Walks parentID links in the session store. */
  const beneath = (sessionID: string, routed: string) => {
    let current = sessionID
    for (let depth = 0; depth < 16; depth++) {
      const parent = context.data.session.get(current)?.parentID
      if (!parent) return false
      if (parent === routed) return true
      current = parent
    }
    return false
  }

  /**
   * Every session beneath `routed`: the one traversal both poll and render share.
   * `family()` returns the whole tree of the routed session's root, so viewing a
   * subagent must still filter out its siblings.
   */
  const descendants = (routed: string) => {
    const result: string[] = []
    for (const sessionID of context.data.session.family(routed)) {
      if (sessionID !== routed && beneath(sessionID, routed)) result.push(sessionID)
    }
    return result
  }

  type Message = ReturnType<typeof context.data.session.message.list>[number]
  type Assistant = Extract<Message, { type: "assistant" }>

  /**
   * Generated characters in an assistant message. This is the measurement
   * definition every figure on screen rests on, so both the sampling and the
   * prediction path go through here rather than each spelling out which parts count.
   */
  const assistantChars = (message: Assistant) => {
    let chars = 0
    for (const item of message.content) {
      if (item.type === "text" || item.type === "reasoning") chars += item.text.length
    }
    return chars
  }

  /** Characters any message adds to the next prompt, as far as the store shows them. */
  const messageChars = (message: Message) => {
    if (message.type === "assistant") return assistantChars(message)
    if ("text" in message && typeof message.text === "string") return message.text.length
    return 0
  }

  /** Tokens the model generated for a message: visible output plus reasoning. */
  const generatedTokens = (tokens: Assistant["tokens"]) => (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

  /**
   * Predict how many tokens the current prompt holds, before the provider says so.
   *
   * The previous assistant step's input plus its output make up almost all of the
   * next prompt; the rest is whatever was appended after it (the new user message,
   * tool results). Returns 0 when there is no previous step to build on.
   *
   * The meter reads this once per message, so it is passed as a thunk: on every
   * other tick these two scans never run.
   */
  const predictPromptTokens = (sessionID: string, currentMessageID: string, meter: TpsMeter) => {
    const messages = context.data.session.message.list(sessionID)
    let baseline = 0
    let baselineIndex = -1
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message.id === currentMessageID) break
      if (message.type === "assistant" && message.tokens?.input) {
        baseline = message.tokens.input + generatedTokens(message.tokens)
        baselineIndex = index
      }
    }
    if (baseline === 0) return 0

    let charsSince = 0
    for (let index = baselineIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      if (message.id === currentMessageID) break
      charsSince += messageChars(message)
    }
    return baseline + meter.tokensFromChars(charsSince)
  }

  const feed = (sessionID: string, busy: boolean) => {
    const messages = context.data.session.message.list(sessionID)
    const message = messages.findLast((entry): entry is Assistant => entry.type === "assistant")
    if (!message) return
    const meter = meterFor(sessionID)
    if (message.time.completed) {
      const tokens = message.tokens
      meter.complete({
        messageID: message.id,
        outputTokens: generatedTokens(tokens),
        // Uncached prompt tokens: the prediction path estimates the *whole* prompt,
        // this exact figure deliberately excludes what the cache already held.
        prefilledTokens: Math.max(0, (tokens?.input ?? 0) - (tokens?.cache?.read ?? 0)),
      })
      return
    }
    meter.sample({
      messageID: message.id,
      chars: assistantChars(message),
      busy,
      createdAt: message.time.created,
      predictPromptTokens: () => predictPromptTokens(sessionID, message.id, meter),
    })
  }

  /** Drop meters for sessions that finished long ago, so a long run cannot grow forever. */
  const prune = (routed: string) => {
    if (meters.size <= MAX_TRACKED_SESSIONS) return
    for (const sessionID of meters.keys()) {
      if (meters.size <= MAX_TRACKED_SESSIONS) break
      if (sessionID === routed) continue
      if (isBusy(sessionID)) continue
      meters.delete(sessionID)
    }
  }

  const routedSession = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const poll = () => {
    const routed = routedSession()
    if (!routed) return
    feed(routed, isBusy(routed))
    for (const sessionID of descendants(routed)) {
      if (isBusy(sessionID)) feed(sessionID, true)
    }
    prune(routed)
  }

  const timer = setInterval(() => {
    poll()
    setVersion((count) => count + 1)
  }, TICK_MS)

  /**
   * Which meters the readout speaks for.
   *
   * Viewing a session that is itself generating (including a subagent you clicked
   * into) reports that session alone. Viewing a parent that is parked on a tool call
   * reports every descendant that is generating, summed - on a single local GPU the
   * aggregate is the number that matches what the server is doing.
   */
  const contributors = (routed: string): TpsMeter[] => {
    const own = meters.get(routed)
    if (own?.active) return [own]

    const active: TpsMeter[] = []
    for (const sessionID of descendants(routed)) {
      const meter = meters.get(sessionID)
      if (meter?.active) active.push(meter)
    }
    return active.length ? active : own ? [own] : []
  }

  type Segment = [string, string | RGBA]

  /** The longest of a set of possibly-absent durations, rendered as muted seconds. */
  const longestWait = (values: Array<number | undefined>): Segment[] => {
    const defined = values.filter((value): value is number => value !== undefined)
    if (!defined.length) return []
    return [[`↑ ${Math.max(...defined).toFixed(1)}s`, context.theme.text.subdued]]
  }

  /** [text, colour] pairs making up the readout, empty while there is nothing to show. */
  const segments = (): Segment[] => {
    version() // subscribe to the tick signal: re-render on every poll
    const muted = context.theme.text.subdued
    const routed = routedSession()
    if (!routed) return []

    const active = contributors(routed)
    if (!active.length) return []

    // Nothing has produced a token yet: show the longest prefill wait in flight.
    const decoding = active.filter((meter) => meter.live !== undefined)
    if (!decoding.length) {
      const waiting = longestWait(active.map((meter) => meter.prefillElapsed))
      if (waiting.length) return waiting
    }

    const parts: Segment[] = []
    const reporting = decoding.length ? decoding : active

    // One pass for both rates: every meter contributes to each total, and each
    // total carries a flag saying whether any contribution was an estimate.
    let prefillTotal = 0
    let prefillKnown = false
    let prefillExact = true
    let decodeTotal = 0
    let decodeKnown = false
    let decodeExact = true
    for (const meter of reporting) {
      const prefill = meter.prefill
      if (prefill !== undefined) {
        prefillTotal += prefill
        prefillKnown = true
        if (!meter.prefillExact) prefillExact = false
      }
      const decode = meter.decode
      if (decode !== undefined) {
        decodeTotal += decode
        decodeKnown = true
        if (!meter.decodeExact) decodeExact = false
      }
    }

    if (prefillKnown) {
      parts.push([
        `↑ ${prefillExact ? "" : "~"}${format(prefillTotal)} tok/s`,
        band(prefillTotal, FAST_PREFILL, OK_PREFILL),
      ])
    } else {
      // No previous step to predict the prompt size from: report plain TTFT instead.
      parts.push(...longestWait(reporting.map((meter) => meter.ttftSeconds)))
    }
    if (decodeKnown) {
      parts.push([`↓ ${decodeExact ? "" : "~"}${format(decodeTotal)} tok/s`, band(decodeTotal, FAST_DECODE, OK_DECODE)])
    }

    const joined = parts.flatMap((part, index): Segment[] => (index ? [[" · ", muted], part] : [part]))
    // Say so when the figures are a sum across several agents rather than one session.
    // Spelled out rather than "×N", which reads as a multiplier applied to the number
    // shown instead of a count of what was added together.
    if (joined.length && reporting.length > 1) joined.push([` (${reporting.length} agents)`, muted])
    return joined
  }

  const releaseSlot = context.ui.slot({
    append: "prompt.footer.status",
    render: () => (
      <text>
        {segments().map(([label, colour]) => (
          <span style={{ fg: colour }}>{label}</span>
        ))}
      </text>
    ),
  })

  return () => {
    clearInterval(timer)
    releaseSlot()
  }
}

export default { id: "tps", setup } satisfies Plugin.Definition
