import { expect, test } from "bun:test"
import { createTpsMeter } from "./meter.ts"

/** A meter on a clock the test controls, starting at t=0. */
const controlledClock = () => {
  let now = 0
  return {
    meter: createTpsMeter(() => now),
    advance: (ms: number) => {
      now += ms
    },
  }
}

const noPrediction = () => 0

test("live decode rate is characters over the window, divided by chars per token", () => {
  const { meter, advance } = controlledClock()
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  advance(1000)
  meter.sample({ messageID: "m1", chars: 400, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  // 400 chars in 1s at the default 4 chars/token
  expect(meter.live).toBeCloseTo(100)
})

test("completing a message replaces the estimate with the provider's exact rate", () => {
  const { meter, advance } = controlledClock()
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  advance(1000)
  meter.sample({ messageID: "m1", chars: 400, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  meter.complete({ messageID: "m1", outputTokens: 200, prefilledTokens: 0 })
  // 200 real output tokens over 1s of active generation
  expect(meter.finalDecode).toBeCloseTo(200)
  // and the 400/200 ratio pulls chars per token down from 4
  expect(meter.tokensFromChars(400)).toBeGreaterThan(100)
})

test("a stale incomplete message on an idle session reports no prefill wait", () => {
  const { meter, advance } = controlledClock()
  // The session was reopened 20 hours after an aborted generation: the message is
  // incomplete, its text is already at its final length, and the session is idle.
  advance(73_000_000)
  meter.sample({ messageID: "m1", chars: 500, busy: false, createdAt: 0, predictPromptTokens: noPrediction })
  expect(meter.prefillElapsed).toBeUndefined()
  expect(meter.active).toBe(false)
})

test("prefill wait counts while the session is busy", () => {
  const { meter, advance } = controlledClock()
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  advance(2400)
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  expect(meter.prefillElapsed).toBeCloseTo(2.4)
})

test("prefill rate is the predicted prompt size over time to first token", () => {
  const { meter, advance } = controlledClock()
  const predictPromptTokens = () => 1000
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens })
  advance(500)
  meter.sample({ messageID: "m1", chars: 10, busy: true, createdAt: 0, predictPromptTokens })
  // 1000 predicted prompt tokens, first character seen after 0.5s
  expect(meter.prefill).toBeCloseTo(2000)
  expect(meter.prefillExact).toBe(false)
})

test("an idle session whose output stopped growing settles to inactive", () => {
  const { meter, advance } = controlledClock()
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  advance(1000)
  meter.sample({ messageID: "m1", chars: 400, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  expect(meter.active).toBe(true)
  // Aborted mid-stream: the message never completes and the session goes idle.
  advance(2000)
  meter.sample({ messageID: "m1", chars: 400, busy: false, createdAt: 0, predictPromptTokens: noPrediction })
  expect(meter.live).toBeUndefined()
  expect(meter.active).toBe(false)
})

test("a newer message completing between ticks ends the tracked stream", () => {
  const { meter, advance } = controlledClock()
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  advance(1000)
  meter.sample({ messageID: "m1", chars: 400, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  // m1 finished and m2 started and finished before the next tick saw either.
  advance(200)
  meter.complete({ messageID: "m2", outputTokens: 20, prefilledTokens: 0 })
  expect(meter.live).toBeUndefined()
  expect(meter.active).toBe(false)
})
