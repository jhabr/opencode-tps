import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { createTpsMeter, type TpsMeter } from "./meter.ts"

/**
 * Renders live prefill and decode throughput to the right of the session prompt.
 *
 *   ↑ 2.4s                        prompt is being prefilled, no output token yet
 *   ↓ ~28.6 tok/s                 decoding
 *   ↑ 2.7k tok/s · ↓ 28.6 tok/s   finished: exact prefill and decode rates
 *
 * The rate maths lives in meter.ts; this file samples the reactive TUI state to
 * drive it, decides which sessions the readout speaks for, and renders.
 *
 * Two traps this works around
 * ---------------------------
 * - The reactive part store grows every ~200ms but freezes for up to ~3s mid
 *   generation. Treating a plateau as "stopped" makes the readout flicker, so the
 *   session's busy status is passed to the meter, which holds the last rate across
 *   plateaus for as long as the model is still working.
 * - A subagent generates in a *child* session; the routed parent session sits frozen
 *   on a tool call for the whole run, so watching only the routed session goes blank.
 *
 * Per session, and summed
 * -----------------------
 * Every session gets its own meter. What the readout speaks for depends on where you
 * are: on a session that is itself generating you get that session alone, so clicking
 * into a subagent shows that agent's rate. On a parent parked on a tool call you get
 * every descendant that is generating, summed and suffixed "(N agents)" - on a single
 * local GPU the aggregate is what matches the server's own throughput. The figure is
 * the total, not a per-agent figure to be multiplied, and the colour bands apply to
 * that total.
 */

const TICK_MS = 200
const MAX_TRACKED_SESSIONS = 32

/**
 * Colour bands. Decode boundaries match the Claude Code statusline
 * (~/.claude/statusline-command.sh); prefill runs one to two orders of magnitude
 * faster so it gets its own. Fixed hex rather than theme.success/warning/error so
 * the bands really do read as green/orange/red on every theme.
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

export async function mount(api: TuiPluginApi) {
  const [version, setVersion] = createSignal(0)

  // One meter per session. A subagent generates in its own child session, so the
  // session that is producing tokens is frequently not the one on screen.
  const meters = new Map<string, TpsMeter>()
  const parentOf = new Map<string, string | undefined>()
  const knownSessions = new Set<string>()

  const meterFor = (sessionID: string) => {
    let meter = meters.get(sessionID)
    if (!meter) {
      meter = createTpsMeter()
      meters.set(sessionID, meter)
    }
    return meter
  }

  const isBusy = (sessionID: string) => api.state.session.status(sessionID)?.type === "busy"

  const offCreated = api.event.on("session.created", (event) => {
    const info = event.properties.info
    knownSessions.add(info.id)
    parentOf.set(info.id, info.parentID)
  })
  const offMessage = api.event.on("message.updated", (event) => {
    knownSessions.add(event.properties.info.sessionID)
  })

  /**
   * Is `sessionID` the routed session or somewhere beneath it?
   *
   * Sessions that existed before this plugin mounted have no recorded parent. They
   * are treated as in-scope so a subagent is never missed; in practice one TUI drives
   * one session tree at a time.
   */
  const inScope = (sessionID: string, routed: string) => {
    if (sessionID === routed) return true
    let current = sessionID
    for (let depth = 0; depth < 16; depth++) {
      if (!parentOf.has(current)) return true
      const parent = parentOf.get(current)
      if (!parent) return false
      if (parent === routed) return true
      current = parent
    }
    return false
  }

  /** Every known session beneath `routed`: the one traversal both poll and render share. */
  const descendants = (routed: string) => {
    const result: string[] = []
    for (const sessionID of knownSessions) {
      if (sessionID !== routed && inScope(sessionID, routed)) result.push(sessionID)
    }
    return result
  }

  /**
   * Generated characters in a message. This is the measurement definition every
   * figure on screen rests on, so both the sampling and the prediction path go
   * through here rather than each spelling out which parts count.
   */
  const textChars = (messageID: string) => {
    let chars = 0
    for (const part of api.state.part(messageID)) {
      if (part.type === "text" || part.type === "reasoning") chars += part.text?.length ?? 0
    }
    return chars
  }

  /** Tokens the model generated for a message: visible output plus reasoning. */
  const generatedTokens = (tokens: any) => (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

  /**
   * Predict how many tokens the current prompt holds, before the provider says so.
   *
   * The previous assistant turn's input plus its output make up almost all of the
   * next prompt; the rest is whatever was appended after it (the new user message,
   * tool results). Returns 0 when there is no previous turn to build on.
   *
   * The meter reads this once per message, so it is passed as a thunk: on every
   * other tick these two scans never run.
   */
  const predictPromptTokens = (sessionID: string, currentMessageID: string, meter: TpsMeter) => {
    const messages = api.state.session.messages(sessionID) as any[]
    let baseline = 0
    let baselineIndex = -1
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message.id === currentMessageID) break
      if (message.role === "assistant" && message.tokens?.input) {
        baseline = message.tokens.input + generatedTokens(message.tokens)
        baselineIndex = index
      }
    }
    if (baseline === 0) return 0

    let charsSince = 0
    for (let index = baselineIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      if (message.id === currentMessageID) break
      charsSince += textChars(message.id)
    }
    return baseline + meter.tokensFromChars(charsSince)
  }

  const feed = (sessionID: string, busy: boolean) => {
    const messages = api.state.session.messages(sessionID) as any[]
    const message = messages.findLast((entry) => entry.role === "assistant")
    if (!message) return
    const meter = meterFor(sessionID)
    if (message.time?.completed) {
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
      chars: textChars(message.id),
      busy,
      createdAt: message.time.created,
      predictPromptTokens: () => predictPromptTokens(sessionID, message.id, meter),
    })
  }

  /**
   * Drop state for sessions that finished long ago, so a long run cannot grow forever.
   * Iterates `knownSessions` because it is a superset of the other two collections:
   * bounding it bounds everything.
   */
  const prune = (routed: string) => {
    if (knownSessions.size <= MAX_TRACKED_SESSIONS) return
    for (const sessionID of knownSessions) {
      if (knownSessions.size <= MAX_TRACKED_SESSIONS) break
      if (sessionID === routed) continue
      if (isBusy(sessionID)) continue
      knownSessions.delete(sessionID)
      meters.delete(sessionID)
      parentOf.delete(sessionID)
    }
  }

  const routedSession = () => {
    const route = api.route.current
    if (route?.name !== "session") return undefined
    return (route.params as any)?.sessionID as string | undefined
  }

  const poll = () => {
    const routed = routedSession()
    if (!routed) return
    knownSessions.add(routed)

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

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    offCreated()
    offMessage()
  })

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
    return [[`↑ ${Math.max(...defined).toFixed(1)}s`, api.theme.current.textMuted]]
  }

  /** [text, colour] pairs making up the readout, empty while there is nothing to show. */
  const segments = (): Segment[] => {
    version() // subscribe to the tick signal: re-render on every poll
    const muted = api.theme.current.textMuted
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
      // No previous turn to predict the prompt size from: report plain TTFT instead.
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

  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right() {
        return (
          <text>
            {/* span honours style={{fg}}, not a bare fg prop */}
            {segments().map(([label, colour]) => (
              <span style={{ fg: colour }}>{label}</span>
            ))}
          </text>
        )
      },
    },
  })
}
