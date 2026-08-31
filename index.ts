import type { Plugin } from "opencode-plugin-v2"

/**
 * opencode 2.0 *server* entry point, and deliberately a no-op: the readout is
 * pure TUI. It exists because v2 discovers plugins server side - a directory
 * plugin needs an `index.*` before the sibling `tui.*` (tui.tsx here) is
 * detected and handed to the TUI to load.
 *
 * Install by symlinking this repository into the v2 plugin directory:
 *
 *   ln -s /path/to/opencode-tps ~/.config/opencode/plugin/tps
 *
 * The v1 plugin (tps.ts, registered via tui.json) ignores this file.
 */

export default {
  id: "tps",
  setup() {},
} satisfies Plugin.Plugin
