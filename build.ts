import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/**
 * Compiles the plugin to dist/ for Git installs. opencode transforms Solid JSX
 * only outside node_modules, so an installed copy of the .tsx sources would be
 * compiled as React JSX and fail. The bundle ships the JSX already compiled to
 * @opentui/solid calls; solid-js and @opentui/* stay external because opencode
 * substitutes its own instances at load time.
 *
 * dist/ is committed: run `bun run build` after changing a source file.
 */

const result = await Bun.build({
  entrypoints: ["./tps.ts"],
  outdir: process.argv[2] ?? "./dist",
  target: "bun",
  format: "esm",
  splitting: true,
  external: ["solid-js", "solid-js/*", "@opentui/*"],
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
