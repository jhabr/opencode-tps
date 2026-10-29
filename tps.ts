import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Plugin } from "opencode-plugin-v2/tui"

/**
 * Realtime tokens/sec readout for the opencode TUI, one entry point for both
 * major versions. Both resolve `exports["./tui"]` in package.json to this file's
 * bundle, dist/tps.js (see build.ts); opencode 1.x calls `tui`, opencode 2.x calls
 * `setup`, and each ignores the other's key.
 *
 * Each UI is imported lazily: the server plugin loader also evaluates this file,
 * and it has no JSX/solid runtime installed, so a static import of the .tsx would
 * throw there and silently drop the plugin.
 */

const tui: TuiPlugin = async (api) => {
  const ui = await import("./tps-ui.tsx")
  await ui.mount(api)
}

const setup = async (context: Plugin.Context) => {
  const ui = await import("./tui.tsx")
  return ui.default.setup(context)
}

export default { id: "tps", tui, setup }
