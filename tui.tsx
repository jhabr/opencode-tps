import { createSignal, untrack } from "solid-js"
import { createTpsMeter, type TpsMeter } from "./meter.ts"
import {
  MAX_TRACKED_SESSIONS,
  TICK_MS,
  contributors,
  generatedTokens,
  needsSample,
  segments as buildSegments,
} from "./readout.ts"
import type { Plugin } from "opencode-plugin-v2/tui"

/**
 * Realtime tokens/sec readout for the opencode 2.0 TUI, rendered in the prompt
 * footer's status cluster.
 *
 *   ↑ 2.4s                        prompt is being prefilled, no output token yet
 *   ↓ ~28.6 tok/s                 decoding
 *   ↑ 2.7k tok/s · ↓ 28.6 tok/s   finished: exact prefill and decode rates
 *
 * The v2 loader reaches this file through tps.ts, the entry point shared with
 * opencode 1.x. The v1 UI lives in tps-ui.tsx; all versions share meter.ts for
 * the rate maths and readout.ts for the presentation policy.
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
      const busy = isBusy(sessionID)
      if (needsSample(busy, meters.get(sessionID))) feed(sessionID, busy)
    }
    prune(routed)
  }

  const timer = setInterval(() => {
    poll()
    setVersion((count) => count + 1)
  }, TICK_MS)

  const releaseSlot = context.ui.slot({
    append: "prompt.footer.status",
    render: () => (
      <text>
        {(() => {
          version() // subscribe to the tick signal: re-render on every poll
          // The reads below hit reactive stores that update far more often than the
          // tick; untrack keeps the tick signal the readout's only render trigger.
          return untrack(() => {
            const routed = routedSession()
            if (!routed) return []
            const active = contributors(
              meters.get(routed),
              descendants(routed).map((sessionID) => meters.get(sessionID)),
            )
            return buildSegments(active, context.theme.text.subdued)
          })
        })().map(([label, colour]) => (
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
