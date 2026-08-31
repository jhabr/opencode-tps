# opencode-tps

Realtime tokens/sec readout for the [opencode](https://opencode.ai) TUI, rendered to the right of the session prompt.

```
↑ 2.4s                          prompt is being prefilled, no output token yet
↓ ~28.6 tok/s                   decoding
↑ 2.7k tok/s · ↓ 28.6 tok/s     finished: exact prefill and decode rates
```

Rates are colour banded green / orange / red so throughput is readable at a glance.

## Install

Register the npm package in `~/.config/opencode/tui.json` (**not** `opencode.json` - TUI plugins load from a separate config file):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-tps"]
}
```

opencode installs the package automatically via Bun on startup. Restart opencode, and confirm it loaded with `ctrl+p` then "Plugins". Pin a version with `opencode-tps@0.1.0` if you want updates to be explicit.

### From a local clone

```bash
git clone git@github.com:jhabr/opencode-tps.git ~/.config/opencode/tui-plugin
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/YOUR_USER/.config/opencode/tui-plugin"]
}
```

The directory reference works because `package.json` declares the TUI entrypoint under `exports["./tui"]`. The path must be absolute; there is no `$HOME` expansion.

### opencode 2.0 (preview)

The same readout ships for the opencode 2.0 TUI as `index.ts` / `tui.tsx`. v2 discovers plugins server side, so install by symlinking the clone into the v2 plugin directory:

```bash
git clone git@github.com:jhabr/opencode-tps.git
ln -s "$(pwd)/opencode-tps" ~/.config/opencode/plugin/tps
```

The server loads the no-op `index.ts`, notices the sibling `tui.tsx`, and hands it to the TUI, which renders the readout in the prompt footer's status cluster. Registering the file under `plugins` in `cli.json` does **not** work as of `v0.0.0-beta-18743`: that path is configured but never loaded.

## Requirements

opencode 1.18.x or later, or opencode 2.0 preview (verified against `v0.0.0-beta-18743`). `solid-js` and `@opentui/*` are supplied by the opencode runtime, so there is nothing to install.

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
| `tps.ts` | v1 plugin entry point. Imports the UI lazily, because the server plugin loader also evaluates this file and has no JSX runtime. |
| `tps-ui.tsx` | v1 UI. Samples the reactive TUI state and renders. |
| `index.ts` | v2 server entry point, a no-op. Exists so v2's server-side discovery finds the directory plugin and its `tui.tsx`. |
| `tui.tsx` | v2 entry point and UI: the `tps-ui.tsx` logic ported to the v2 plugin API (content arrays, `session.family()`, slot claims). |
| `meter.ts` | The rate maths, shared by both versions. No UI dependency, so it runs under test without a TUI. |
| `readout.ts` | The presentation policy shared by both versions: colour bands, formatting, which meters a view speaks for, segment aggregation. |

## Tests

```bash
bun test
```

Covers `meter.ts` only, driven through an injected clock. `tps-ui.tsx` needs a live TUI runtime and is not tested.

## Licence

MIT, see [LICENSE](LICENSE).
