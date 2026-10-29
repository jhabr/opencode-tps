/**
 * opencode 2.x entry point. Register this directory, not the repository root, in
 * the `plugins` array of ~/.config/opencode/cli.json:
 *
 *   "plugins": ["/path/to/opencode-tps/v2"]
 *
 * The v2 loader resolves a directory plugin through its package.json `exports`
 * when it has one, and the root package.json exports the v1 entry (tps.ts) for
 * opencode 1.x. This directory has no package.json, so the loader falls back to
 * the literal `tui.*` file and lands here.
 */
export { default } from "../tui.tsx"
