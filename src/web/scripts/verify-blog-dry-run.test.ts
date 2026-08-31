import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseWranglerBindings, verifyBlogDryRunEvidence } from "./verify-blog-dry-run"

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
  it("parses and accepts the assets-only inventory", () => {
    expect(parseWranglerBindings(successfulOutput)).toEqual(["ASSETS"])
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: '[assets]\nbinding = "ASSETS"\nhtml_handling = "none"\nrun_worker_first = true',
    })).not.toThrow()
  })

  it.each(["NEXT_TAG_CACHE_D1", "NEXT_INC_CACHE_R2_BUCKET", "BLOG_WORKER"])(
    "rejects the unexpected %s binding",
    (binding) => {
      expect(() => verifyBlogDryRunEvidence({
        ...fixture(),
        output: successfulOutput.replace("env.ASSETS         Assets", `env.ASSETS Assets\nenv.${binding} Service`),
        wranglerToml: '[assets]\nbinding = "ASSETS"\nhtml_handling = "none"\nrun_worker_first = true',
      })).toThrow()
    },
  )

  it("rejects asset-first routing that redirects /blog before OpenNext runs", () => {
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: '[assets]\nbinding = "ASSETS"',
    })).toThrow("run the Worker first")
  })

  it("rejects automatic asset HTML redirects for OpenNext-owned routes", () => {
    expect(() => verifyBlogDryRunEvidence({
      ...fixture(),
      output: successfulOutput,
      wranglerToml: '[assets]\nbinding = "ASSETS"\nrun_worker_first = true',
    })).toThrow("disable HTML redirects")
  })
})
