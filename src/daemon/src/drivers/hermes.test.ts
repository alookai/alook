import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HermesDriver } from "./hermes";
import { CredentialBroker } from "../credentials/credentialProxy";
import type { LaunchContext } from "../types";

/**
 * Integration-style test that does NOT need a live Hermes backend.
 *
 * We drop a fake `hermes` executable on disk that records the exact argv/env it
 * was launched with and then emits a realistic quiet-mode (`-Q`) transcript
 * (response lines + `session_id:` footer). The test asserts:
 *   1. HermesDriver.spawn() resolves the binary and builds the right args,
 *   2. the recorded argv matches the canonical `hermes chat -q ... -Q
 *      --pass-session-id [--provider] [--model] [--resume] [--yolo]` shape,
 *   3. the normalizer collapses the fake transcript into text + turn_end.
 *
 * `prepareCliTransport` (shared by every CLI runtime) requires a
 * `credentialProxy`, so we supply the same minimal mock the project's own
 * cliTransport tests use.
 */
function mkTmp(): string {
  // Use a space-free base dir so the spawned `.cmd` (launched via cmd.exe with
  // shell:true) doesn't trip Windows' unquoted-path parsing — this matches how
  // every other daemon driver's binary is resolved on PATH (no spaces).
  const base = process.env.ALOOK_TEST_TMP || "C:\\alook_hermes_test";
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "t-"));
}
const tmpDirs: string[] = [];
function broker(): CredentialBroker {
  const d = mkTmp();
  tmpDirs.push(d);
  return new CredentialBroker({ upstreamBaseUrl: "https://upstream.test", voucherDir: d });
}

const RECORDED: { argv: string[]; env: Record<string, string | undefined> } = { argv: [], env: {} };

function makeFakeHermes(): string {
  const dir = mkTmp();
  const isWin = process.platform === "win32";
  const jsPath = path.join(dir, "hermes.js");
  const js = [
    "const fs = require('fs');",
    "const path = require('path');",
    // prepareCliTransport builds a deliberate env (no arbitrary passthrough), so
    // we can't rely on an env var reaching us. Write the record next to this
    // script, which the test can locate via the dir it created.
    "const rec = path.join(path.dirname(process.argv[1]), 'record.json');",
    "fs.writeFileSync(rec, JSON.stringify({ argv: process.argv.slice(1), env: { HERMES_QUIET: process.env.HERMES_QUIET, HERMES_INTERACTIVE: process.env.HERMES_INTERACTIVE, ALOOK_HERMES_PROVIDER: process.env.ALOOK_HERMES_PROVIDER } }));",
    "process.stdout.write('Here is the patch.\\n');",
    "process.stdout.write('session_id: ' + (process.env.HERMES_TEST_SESSION || 'ses_fake_001') + '\\n');",
    "process.exit(0);",
  ].join("\n");
  fs.writeFileSync(jsPath, js);
  const bin = path.join(dir, isWin ? "hermes.cmd" : "hermes.sh");
  const body = isWin
    ? `@echo off\r\nnode "${jsPath}" %*\r\n`
    : `#!/usr/bin/env bash\nnode "${jsPath}" "$@"\n`;
  fs.writeFileSync(bin, body);
  if (!isWin) fs.chmodSync(bin, 0o755);
  return bin;
}

describe("HermesDriver.spawn — fake backend integration", () => {
  let fakeHermes: string;
  let recordFile: string;

  beforeEach(() => {
    fakeHermes = makeFakeHermes();
    recordFile = path.join(path.dirname(fakeHermes), "record.json");
    process.env.HERMES_RECORD_FILE = recordFile;
  });

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
    try { fs.unlinkSync(recordFile); } catch { /* noop */ }
    delete process.env.HERMES_RECORD_FILE;
  });

  it("spawns the fake hermes with the canonical quiet-mode args and parses its transcript", async () => {
    const driver = new HermesDriver();
    const ctx = {
      agentId: "agent-1",
      launchId: "launch-1",
      workingDirectory: mkTmp(),
      standingPrompt: "You are a dev agent.",
      prompt: "Fix the bug in main.ts",
      agentCliPath: fakeHermes,
      credentialProxy: { broker: broker(), proxyUrl: "http://127.0.0.1:9/proxy", runnerKey: "rk_test", capabilities: ["send", "read"] },
      config: {
        runtimeConfig: {
          version: 1,
          runtime: "hermes",
          model: { kind: "named", name: "tencent/hy3:free" },
          mode: { kind: "default" },
          provider: { kind: "custom", providerId: "nous", apiUrl: "https://inference-api.nousresearch.com/v1", apiKey: "x" },
        },
      },
    } as unknown as LaunchContext;

    const result = await driver.spawn(ctx);
    // Give the fake process a tick to run + write its record file.
    await new Promise((r) => setTimeout(r, 200));
    expect(result.process).toBeDefined();

    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    expect(recorded.argv).toContain("chat");
    expect(recorded.argv).toContain("-q");
    expect(recorded.argv).toContain("Fix the bug in main.ts");
    expect(recorded.argv).toContain("-Q");
    expect(recorded.argv).toContain("--pass-session-id");
    expect(recorded.argv).toContain("--provider");
    expect(recorded.argv).toContain("nous");
    expect(recorded.argv).toContain("--model");
    expect(recorded.argv).toContain("tencent/hy3:free");
    expect(recorded.argv).toContain("--yolo");
    expect(recorded.env.HERMES_QUIET).toBe("1");
    expect(recorded.env.HERMES_INTERACTIVE).toBe("0");

    const transcript = ["Here is the patch.", "session_id: ses_fake_001"];
    const events = transcript.flatMap((l) => driver.parseLine(l));
    const texts = events.filter((e) => e.kind === "text").map((e) => (e as any).text);
    expect(texts).toEqual(["Here is the patch."]);
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    expect(events.some((e) => e.kind === "session_init")).toBe(true);
    expect(driver.currentSessionId).toBe("ses_fake_001");
  });
});
