import { expect, test } from "bun:test"
import { createTpsMeter } from "./meter.ts"
import { needsSample } from "./readout.ts"

const noPrediction = () => 0

test("busy sessions are always sampled", () => {
  expect(needsSample(true, undefined)).toBe(true)
  expect(needsSample(true, createTpsMeter())).toBe(true)
})

test("an idle session is sampled until its meter settles", () => {
  let now = 0
  const meter = createTpsMeter(() => now)
  meter.sample({ messageID: "m1", chars: 0, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  now = 1000
  meter.sample({ messageID: "m1", chars: 400, busy: true, createdAt: 0, predictPromptTokens: noPrediction })
  // The agent finished: still active until a sample sees the completed message.
  expect(needsSample(false, meter)).toBe(true)
  meter.complete({ messageID: "m1", outputTokens: 100, prefilledTokens: 0 })
  expect(needsSample(false, meter)).toBe(false)
})

test("an idle session without a meter is not sampled", () => {
  expect(needsSample(false, undefined)).toBe(false)
})
