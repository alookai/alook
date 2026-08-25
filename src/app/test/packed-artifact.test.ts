import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: mocks.spawnSync };
});

const { verifyExtractedPackage } = await import("../scripts/verify-packed-artifact.mjs");

const scratchRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alook-packed-artifact-test-"));
  scratchRoots.push(root);
  const packageRoot = join(root, "candidate");
  const webRoot = join(packageRoot, "bundled", "web");
  mkdirSync(join(webRoot, "src", "lib"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), "{}");
  writeFileSync(join(webRoot, "wrangler.toml"), 'main = "custom-worker.ts"\n');
  writeFileSync(join(webRoot, "custom-worker.ts"), 'import "./src/lib/worker-runtime";\n');
  writeFileSync(join(webRoot, "src", "lib", "worker-runtime.ts"), "export {};\n");
  return { root, packageRoot, scratchRoot: join(root, "scratch") };
}

afterEach(() => {
  mocks.spawnSync.mockReset();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packed artifact verifier", () => {
  it("derives the missing-runtime negative control from the candidate and validates both outcomes", () => {
    const { packageRoot, scratchRoot } = fixture();
    mocks.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: 'Could not resolve "./src/lib/worker-runtime"' })
      .mockImplementationOnce((_command, args: string[]) => {
        const outdir = args[args.indexOf("--outdir") + 1];
        mkdirSync(outdir, { recursive: true });
        writeFileSync(join(outdir, "index.js"), "export default {};\n");
        return { status: 0, stdout: "dry-run complete", stderr: "" };
      });

    const result = verifyExtractedPackage(packageRoot, scratchRoot);

    expect(existsSync(join(packageRoot, "bundled", "web", "src", "lib", "worker-runtime.ts"))).toBe(true);
    expect(existsSync(join(scratchRoot, "negative", "package", "bundled", "web", "src", "lib", "worker-runtime.ts"))).toBe(false);
    expect(existsSync(result.positiveOut)).toBe(true);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("rejects a negative control that Wrangler accepts", () => {
    const { packageRoot, scratchRoot } = fixture();
    mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: "unexpected", stderr: "" });

    expect(() => verifyExtractedPackage(packageRoot, scratchRoot)).toThrow(
      "0.1.18-shaped negative artifact unexpectedly passed Wrangler dry-run",
    );
  });
});
