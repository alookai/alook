import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { matchesWorkerFirst, parseRunWorkerFirstRules, parseWranglerBindings, verifyBlogDryRunEvidence } from "./verify-blog-dry-run"

const validBlogWranglerToml = `[assets]
binding = "ASSETS"
html_handling = "none"
not_found_handling = "none"
run_worker_first = [
  "/*",
  "!/_next/static/*",
  "!/blog-static/_next/static/*",
  "!/blog/_generated/*",
  "!/blog/*.webp",
  "!/usecases/*.webp",
  "!/fonts/*",
  "!/alook.svg",
  "!/favicon.ico",
]`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alook-blog-dry-run-test-"))
  const outdir = join(root, "dry-run")
  const openNextDir = join(root, ".open-next")
  mkdirSync(join(openNextDir, "server-functions/default"), { recursive: true })
  mkdirSync(outdir)
  writeFileSync(join(outdir, "custom-worker.js"), "export default {}")
  return { outdir, openNextDir }
}

const successfulOutput = `Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets

--dry-run: exiting now.`

describe("Blog Wrangler dry-run verifier", () => {
  it("parses and accepts the assets-only inventory with narrowed run_worker_first", () => {
    expect(parseWranglerBindings(successfulOutput)).toEqual(["ASSETS"])
    const rules = parseRunWorkerFirstRules(validBlogWranglerToml)
    expect(rules).toContain("/*")
    expect(matchesWorkerFirst(rules!, "/blog/introducing-alook")).toBe(true)
    expect(matchesWorkerFirst(rules!, "/blog-static/_next/static/chunks/app.js")).toBe(false)
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: validBlogWranglerToml,
    })).not.toThrow()
  })

  it.each(["NEXT_TAG_CACHE_D1", "NEXT_INC_CACHE_R2_BUCKET", "BLOG_WORKER"])(
    "rejects the unexpected %s binding",
    (binding) => {
      expect(() => verifyBlogDryRunEvidence({
        ...fixture(),
        output: successfulOutput.replace("env.ASSETS         Assets", `env.ASSETS Assets\nenv.${binding} Service`),
        wranglerToml: validBlogWranglerToml,
      })).toThrow()
    },
  )

  it("rejects missing or blanket boolean run_worker_first", () => {
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: '[assets]\nbinding = "ASSETS"\nhtml_handling = "none"\nnot_found_handling = "none"',
    })).toThrow("narrowed run_worker_first")
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: '[assets]\nbinding = "ASSETS"\nhtml_handling = "none"\nnot_found_handling = "none"\nrun_worker_first = true',
    })).toThrow("narrowed run_worker_first")
  })

  it("rejects overly broad exclusions that bypass the Worker for /blog routes or fail to exclude static chunks", () => {
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: validBlogWranglerToml.replace('"!/blog/*.webp",', '"!/blog/*",'),
    })).toThrow("Blog Worker must run first for /blog/introducing-alook")
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: validBlogWranglerToml.replace('  "!/blog-static/_next/static/*",\n', ""),
    })).toThrow("Blog static asset must bypass Worker")
  })

  it("rejects missing html_handling or not_found_handling none settings", () => {
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: validBlogWranglerToml.replace('html_handling = "none"\n', ""),
    })).toThrow("disable HTML redirects")
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: validBlogWranglerToml.replace('not_found_handling = "none"\n', ""),
    })).toThrow('not_found_handling = "none"')
  })
})
