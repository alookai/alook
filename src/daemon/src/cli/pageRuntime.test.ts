import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ensurePageRuntime, readPageGuide, runPageLocalCli } from "./pageRuntime";

async function makeFakeRuntimeTarball(baseDir: string) {
  const src = join(baseDir, "src");
  await mkdir(join(src, "runtime"), { recursive: true });
  await mkdir(join(src, "guides", "slides", "reference"), { recursive: true });
  await mkdir(join(src, "guides", "page"), { recursive: true });
  await writeFile(join(src, "runtime", "cli.mjs"), [
    'const args = process.argv.slice(2);',
    'if (args[0] === "fail") { console.error("bad input"); process.exit(2); }',
    'if (args[0] === "echo-stdin") {',
    '  let data = "";',
    '  for await (const chunk of process.stdin) data += chunk;',
    '  console.log(JSON.stringify({ ok: true, argv: args, stdin: data }));',
    '  process.exit(0);',
    '}',
    'console.log(JSON.stringify({ ok: true, argv: args, serverHome: process.env.OPEN_ARTIFACT_TYPE_SERVER_HOME }));',
  ].join("\n") + "\n");
  await writeFile(join(src, "guides", "slides", "SKILL.md"), "# Slides Skill\nUse project/deck.json.\n");
  await writeFile(join(src, "guides", "slides", "reference", "format.md"), "# Slides Format\n");
  await writeFile(join(src, "guides", "page", "SKILL.md"), "# Page Skill\n");
  const tarball = join(baseDir, "runtime.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", src, "runtime", "guides"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { src, tarball, bytes, sha256 };
}

describe("pageRuntime", () => {
  it("lazily downloads, verifies SHA-256, extracts to shared cache, and reuses the cached copy without re-downloading", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "alook-rt-test-"));
    const alookHome = join(tmp, "home");
    const { bytes, sha256 } = await makeFakeRuntimeTarball(tmp);
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "application/gzip");
      res.end(bytes);
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/alook-page-runtime.tar.gz`;
    try {
      const first = await ensurePageRuntime({
        env: { ALOOK_HOME: alookHome },
        cacheKey: "0.16.3-testkey-aabbcc",
        downloadUrl: url,
        sha256,
      });
      expect(first.source).toBe("downloaded");
      expect(hits).toBe(1);

      const second = await ensurePageRuntime({
        env: { ALOOK_HOME: alookHome },
        cacheKey: "0.16.3-testkey-aabbcc",
        downloadUrl: url,
        sha256,
      });
      expect(second.source).toBe("cache");
      expect(second.rootDir).toBe(first.rootDir);
      expect(hits).toBe(1);

      const guide = await readPageGuide(second, "slides");
      expect(guide).toMatchObject({ type: "slides", references: ["format.md"] });
      expect(guide.content).toContain("alook page local");
      expect(guide.content).toContain("project/deck.json");

      const refGuide = await readPageGuide(second, "slides", "format.md");
      expect(refGuide.content).toContain("# Slides Format");

      await expect(readPageGuide(second, "slides", "../SKILL.md")).rejects.toThrow("Invalid Page guide reference");

      const cliRes = await runPageLocalCli(second, ["check", "/tmp/demo"], {
        env: { ALOOK_HOME: alookHome },
      });
      expect(cliRes.exitCode).toBe(0);
      expect(JSON.parse(cliRes.stdout)).toEqual({
        ok: true,
        argv: ["check", "/tmp/demo"],
        serverHome: join(alookHome, "page-runtime", ".server-state", "0.16.3-testkey-aabbcc"),
      });

      const customHomeRes = await runPageLocalCli(second, ["check", "/tmp/demo"], {
        env: { ALOOK_HOME: alookHome, OPEN_ARTIFACT_TYPE_SERVER_HOME: join(tmp, "custom-state") },
      });
      expect(JSON.parse(customHomeRes.stdout)).toMatchObject({
        serverHome: join(tmp, "custom-state"),
      });

      const stdinRes = await runPageLocalCli(second, ["echo-stdin", "-"], {
        stdinStream: Readable.from(['{"kind":"applyEdits","base":0,"edits":[]}']),
      });
      expect(stdinRes.exitCode).toBe(0);
      expect(JSON.parse(stdinRes.stdout)).toEqual({
        ok: true,
        argv: ["echo-stdin", "-"],
        stdin: '{"kind":"applyEdits","base":0,"edits":[]}',
      });

      const failRes = await runPageLocalCli(second, ["fail"]);
      expect(failRes.exitCode).toBe(2);
      expect(failRes.stderr.trim()).toBe("bad input");
    } finally {
      await new Promise<void>(r => server.close(() => r()));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects SHA-256 mismatch and insecure non-loopback HTTP URLs without writing to cache", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "alook-rt-bad-"));
    const alookHome = join(tmp, "home");
    const { bytes } = await makeFakeRuntimeTarball(tmp);
    const server = createServer((_req, res) => { res.end(bytes); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(ensurePageRuntime({
        env: { ALOOK_HOME: alookHome },
        cacheKey: "0.16.3-badsha",
        downloadUrl: `http://127.0.0.1:${port}/bad.tar.gz`,
        sha256: "0".repeat(64),
      })).rejects.toThrow("SHA-256 mismatch");

      await expect(ensurePageRuntime({
        env: { ALOOK_HOME: alookHome },
        cacheKey: "0.16.3-insecure",
        downloadUrl: "http://remote.invalid/runtime.tar.gz",
        sha256: "a".repeat(64),
      })).rejects.toThrow("insecure");
    } finally {
      await new Promise<void>(r => server.close(() => r()));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports ALOOK_PAGE_RUNTIME_DIR directly for local development without network access", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "alook-rt-env-"));
    const { src } = await makeFakeRuntimeTarball(tmp);
    try {
      const resolved = await ensurePageRuntime({ env: { ALOOK_PAGE_RUNTIME_DIR: src } });
      expect(resolved.source).toBe("env");
      expect(resolved.rootDir).toBe(realpathSync(src));
      await expect(ensurePageRuntime({ env: { ALOOK_PAGE_RUNTIME_DIR: join(tmp, "missing") } })).rejects.toThrow("incomplete");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
