import type { RGBA } from "@opentui/core"
import type { TpsMeter } from "./meter.ts"

/**
 * The presentation policy of the readout, shared by the v1 (tps-ui.tsx) and v2
 * (tui.tsx) plugins: colour bands, number formatting, which meters speak for a
 * session, and how their rates aggregate into [text, colour] segments. Pure
 * data-in data-out like meter.ts - each version file keeps only its host-API
 * adapter (sampling, session traversal, JSX).
 */

export const TICK_MS = 200
export const MAX_TRACKED_SESSIONS = 32

/**
 * Colour bands. Decode boundaries match the Claude Code statusline
 * (~/.claude/statusline-command.sh); prefill runs one to two orders of magnitude
 * faster so it gets its own. Fixed hex rather than theme colours so the bands
 * really do read as green/orange/red on every theme.
 */
export const FAST_DECODE = 50
export const OK_DECODE = 25
export const FAST_PREFILL = 2000
export const OK_PREFILL = 500
const FAST_COLOUR = "#3fb950"
const OK_COLOUR = "#e3861b"
const SLOW_COLOUR = "#f85149"

export type Colour = string | RGBA
export type Segment = [string, Colour]

export const format = (rate: number) => {
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k`
  if (rate >= 100) return rate.toFixed(0)
  return rate.toFixed(1)
}

export const band = (rate: number, fast: number, ok: number) =>
  rate >= fast ? FAST_COLOUR : rate >= ok ? OK_COLOUR : SLOW_COLOUR

/** Tokens the model generated for a message: visible output plus reasoning. */
export const generatedTokens = (tokens: { output?: number; reasoning?: number } | undefined) =>
  (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

/**
 * Which meters the readout speaks for.
 *
 * Viewing a session that is itself generating (including a subagent you clicked
 * into) reports that session alone. Viewing a parent that is parked on a tool call
 * reports every descendant that is generating, summed - on a single local GPU the
 * aggregate is the number that matches what the server is doing. The caller
 * enumerates the descendant meters; absent entries are tolerated.
 */
export const contributors = (
  own: TpsMeter | undefined,
  descendants: Array<TpsMeter | undefined>,
): TpsMeter[] => {
  if (own?.active) return [own]

  const active = descendants.filter((meter): meter is TpsMeter => meter?.active === true)
  return active.length ? active : own ? [own] : []
}

/** The longest of a set of possibly-absent durations, rendered as muted seconds. */
const longestWait = (values: Array<number | undefined>, muted: Colour): Segment[] => {
  const defined = values.filter((value): value is number => value !== undefined)
  if (!defined.length) return []
  return [[`↑ ${Math.max(...defined).toFixed(1)}s`, muted]]
}

/** [text, colour] pairs making up the readout, empty while there is nothing to show. */
export const segments = (active: TpsMeter[], muted: Colour): Segment[] => {
  if (!active.length) return []

  // Nothing has produced a token yet: show the longest prefill wait in flight.
  const decoding = active.filter((meter) => meter.live !== undefined)
  if (!decoding.length) {
    const waiting = longestWait(active.map((meter) => meter.prefillElapsed), muted)
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
    parts.push(...longestWait(reporting.map((meter) => meter.ttftSeconds), muted))
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
