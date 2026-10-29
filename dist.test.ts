import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// dist/ is committed for Git installs, so it must match a fresh build of the sources.
test("dist/ is up to date with the sources", () => {
  const outdir = mkdtempSync(join(tmpdir(), "opencode-tps-dist-"))
  try {
    const build = Bun.spawnSync({ cmd: ["bun", "build.ts", outdir], cwd: import.meta.dir })
    if (build.exitCode !== 0) throw new Error(`build.ts failed:\n${build.stderr.toString()}`)

    const committed = join(import.meta.dir, "dist")
    const files = readdirSync(outdir).sort()
    expect(readdirSync(committed).sort()).toEqual(files)
    for (const file of files) {
      expect(readFileSync(join(committed, file), "utf8")).toBe(readFileSync(join(outdir, file), "utf8"))
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
})
