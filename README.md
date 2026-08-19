# opencode-tps

Realtime tokens/sec readout for the [opencode](https://opencode.ai) TUI, rendered to the right of the session prompt.

```
↑ 2.4s                          prompt is being prefilled, no output token yet
↓ ~28.6 tok/s                   decoding
↑ 2.7k tok/s · ↓ 28.6 tok/s     finished: exact prefill and decode rates
```

Rates are colour banded green / orange / red so throughput is readable at a glance.

## Install

Clone into your opencode config directory:

```bash
git clone git@github.com:jhabr/opencode-tps.git ~/.config/opencode/tui-plugin
```

Then register it in `~/.config/opencode/tui.json` (**not** `opencode.json` - TUI plugins load from a separate config file):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/YOUR_USER/.config/opencode/tui-plugin/tps.ts"]
}
```

The path must be absolute; there is no `$HOME` expansion. Restart opencode, and confirm it loaded with `ctrl+p` then "Plugins".

## Requirements

opencode 1.18.x or later. `solid-js` and `@opentui/*` are supplied by the opencode runtime, so there is nothing to install.

## How it works

The TUI plugin event bus delivers only coarse part updates with no token deltas, so throughput is sampled rather than reported: every 200ms the accumulated text length of the active assistant message is read from the reactive TUI state and differenced over a 5s sliding window.

- **Decode** is live but estimated (characters ÷ chars-per-token, starting at a generic 4 and recalibrated from the exact token count the provider reports on completion). Estimates carry a `~`.
- **Prefill** is prompt tokens ÷ time to first token. A prefill *rate* cannot exist before the first token lands, so the prompt size is predicted from the previous turn until the provider reports the exact count. Measured against three turns of a real session, that prediction lands within 0.15%.
- TTFT is measured client side, so it includes opencode's request build and the network hop.

Two behaviours worth knowing:

- The reactive part store can freeze for up to ~3s mid generation. While the session reports busy, the last rate is held through gaps rather than flickering to zero.
- Subagents generate in *child* sessions. On a parent session parked on a tool call, every generating descendant is summed and suffixed `(N agents)`; on a session that is itself generating you get that session alone. The figure is a total, not a per-agent number.

## Files

| File | Purpose |
| --- | --- |
| `tps.ts` | Plugin entry point. Imports the UI lazily, because the server plugin loader also evaluates this file and has no JSX runtime. |
| `tps-ui.tsx` | Samples the reactive TUI state, decides which sessions the readout speaks for, renders. |
| `meter.ts` | The rate maths. No UI dependency, so it runs under test without a TUI. |

## Tests

```bash
bun test
```

Covers `meter.ts` only, driven through an injected clock. `tps-ui.tsx` needs a live TUI runtime and is not tested.

## Licence

MIT, see [LICENSE](LICENSE).
