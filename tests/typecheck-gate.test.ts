/**
 * @failure  The typecheck gate silently stops checking code — a package drops
 *           out of the build, a tsconfig's `include` empties, or the root
 *           config is used as if it compiled the sources. A gate that checks
 *           nothing reports success forever.
 * @level    l0
 * @consumer `bun run typecheck`, and every reviewer who reads its exit code.
 *
 * Why this exists. The repo's typecheck was `tsc --noEmit` at the ROOT, whose
 * tsconfig is `"include": []` with project references — so it compiled ZERO
 * files and passed unconditionally. It hid a missing member on a snapshot type
 * and a syntax error in an edit, both of which shipped green. `packages/vt220`
 * was also absent from `references`, so one of three engines was dark even
 * once the invocation was fixed.
 *
 * Asserting "typecheck passes" cannot catch that: a vacuous gate passes too.
 * The only honest check is on SCOPE — does the configured typecheck actually
 * read our source? `--listFilesOnly` answers that without compiling or
 * mutating anything.
 */
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function packageDirs(): string[] {
  return readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "packages", e.name, "tsconfig.json")))
    .map((e) => e.name)
    .sort()
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

/** Files a tsconfig would actually compile. No emit, no mutation. */
function compiledFiles(projectDir: string): string[] {
  const out = execFileSync("tsc", ["-p", projectDir, "--noEmit", "--listFilesOnly"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return out.split("\n").filter((line) => line.trim().length > 0)
}

const packages = packageDirs()

describe("the typecheck gate actually checks", () => {
  test("there are packages to check (a silent zero here would fake every assertion below)", () => {
    expect(packages.length).toBeGreaterThan(0)
  })

  test("the root tsconfig references every package", () => {
    const root = readJson(join(ROOT, "tsconfig.json"))
    const referenced = ((root.references ?? []) as { path: string }[]).map((r) => r.path).sort()
    expect(referenced).toEqual(packages.map((p) => `packages/${p}`))
  })

  for (const pkg of packages) {
    test(`${pkg}: tsconfig declares a non-empty include`, () => {
      const cfg = readJson(join(ROOT, "packages", pkg, "tsconfig.json"))
      // `"include": []` is what made the ROOT config vacuous. A package that
      // acquires it would go dark the same way, silently.
      expect(cfg.include, `packages/${pkg}/tsconfig.json include`).toBeDefined()
      expect((cfg.include as string[]).length).toBeGreaterThan(0)
    })

    test(`${pkg}: the configured typecheck really compiles its own source`, () => {
      const files = compiledFiles(join("packages", pkg))
      const own = files.filter((f) => f.includes(`packages/${pkg}/src/`))
      expect(own.length, `packages/${pkg} compiled no files under its own src/`).toBeGreaterThan(0)
    })
  }

  test("the ROOT config compiles nothing, which is why it must never be the gate", () => {
    // Pinning the trap rather than the cure: if someone later points the
    // typecheck script back at the root, this states plainly what they get.
    const files = compiledFiles(".").filter((f) => f.includes("/packages/"))
    expect(files).toHaveLength(0)
  })
})
