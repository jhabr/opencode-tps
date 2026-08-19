import type { TuiPlugin } from "@opencode-ai/plugin/tui"

/**
 * Realtime tokens/sec readout for the opencode TUI.
 *
 * Registered from ~/.config/opencode/tui.json ("plugin": [...]), NOT opencode.json.
 *
 * The rendering half lives in tps-ui.tsx and is imported lazily: the server plugin
 * loader also evaluates this file, and it has no JSX/solid runtime installed, so a
 * static import of the .tsx would throw there and silently drop the plugin.
 */

const tui: TuiPlugin = async (api) => {
  const ui = await import("./tps-ui.tsx")
  await ui.mount(api)
}

export default { id: "tps", tui }
