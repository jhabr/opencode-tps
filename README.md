# opencode-tps

Realtime tokens/sec readout for the [opencode](https://opencode.ai) TUI, rendered to the right of the session prompt.

```
↑ 2.4s                          prompt is being prefilled, no output token yet
↓ ~28.6 tok/s                   decoding
↑ 2.7k tok/s · ↓ 28.6 tok/s     finished: exact prefill and decode rates
```

Rates are colour banded green / orange / red so throughput is readable at a glance.

## Install

**opencode 2.x**: install straight from GitHub:

```bash
opencode plugin add github:jhabr/opencode-tps
```

This adds it under `plugins` in `~/.config/opencode/cli.json`. Restart opencode and confirm it loaded with `ctrl+p` then "Plugins".

### From a local clone

```bash
git clone git@github.com:jhabr/opencode-tps.git ~/dev/opencode-tps
```

Register the clone with the opencode version you run. The path must be absolute; there is no `$HOME` expansion.

**opencode 2.x**: under `plugins` in `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/Users/YOUR_USER/dev/opencode-tps"]
}
```

**opencode 1.x**: under `plugin` in `~/.config/opencode/tui.json` (**not** `opencode.json` - TUI plugins load from a separate config file):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/YOUR_USER/dev/opencode-tps"]
}
```

### How it loads

Both versions resolve `exports["./tui"]` in `package.json` to `dist/tps.js`, whose default export carries a hook for each: `tui` for 1.x, `setup` for 2.x. `dist/` is a committed, prebuilt bundle because opencode compiles a plugin's Solid JSX only outside `node_modules`, and a Git install lands inside it. After changing a source file, rebuild with `bun run bundle`; the test suite fails while `dist/` is stale.

There is no npm package: the `opencode-tps` name on npm belongs to an unrelated package.

## Requirements

opencode 1.18.x or later (verified against 1.19.5), or opencode 2.x (verified against 2.2.1). `solid-js` and `@opentui/*` are supplied by the opencode runtime, so there is nothing to install.

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
| `tps.ts` | Entry point for both versions, bundled to `dist/tps.js`: `tui` for 1.x, `setup` for 2.x. Imports each UI lazily, because the server plugin loader also evaluates this file and has no JSX runtime. |
| `tps-ui.tsx` | v1 UI. Samples the reactive TUI state and renders. |
| `tui.tsx` | v2 UI: the `tps-ui.tsx` logic ported to the v2 plugin API (content arrays, `session.family()`, slot claims). |
| `meter.ts` | The rate maths, shared by both versions. No UI dependency, so it runs under test without a TUI. |
| `readout.ts` | The presentation policy shared by both versions: colour bands, formatting, which meters a view speaks for, segment aggregation. |
| `build.ts` | Bundles `tps.ts` to `dist/` with the JSX compiled; `solid-js` and `@opentui/*` stay external for opencode to provide. |
| `dist/` | The committed bundle that `package.json` exports. Generated, do not edit. |

## Tests

```bash
bun test
```

Covers `meter.ts` (driven through an injected clock), `readout.ts`, and that `dist/` matches a fresh build. The UIs need a live TUI runtime and are not tested.

## Licence

MIT, see [LICENSE](LICENSE).
