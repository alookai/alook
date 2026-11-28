import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgyQuota, readAgyQuota } from "./quota.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const usage = { status: "SUCCESS", command: { name: "usage", data: { groups: [{ buckets: [{ id: "gemini", name: "Gemini models", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-11-17T00:00:00Z" }] }] } }, num_turns: 0, conversation_id: "", usage: { input_tokens: 0, output_tokens: 0 } };

describe("AGY native read-only quota", () => {
  it("maps native account usage and rejects output that ran a model turn", () => {
    expect(parseAgyQuota(usage, "A".repeat(22))).toMatchObject({ status: "available", limits: [{ usedPercent: 75, resetsAt: "2026-11-17T00:00:00.000Z" }] });
    for (const value of [{ ...usage, num_turns: 1 }, { ...usage, conversation_id: "unexpected" }, { ...usage, usage: { input_tokens: 10 } }, { ...usage, command: { name: "usage", data: { groups: [{ buckets: [{ id: "bad" }] }] } } }]) {
      expect(parseAgyQuota(value, "A".repeat(22))).toMatchObject({ status: "error", code: "invalid_response" });
    }
  });

  it.skipIf(process.platform === "win32")("preflights sign-in, sends only /usage and invalidates an unidentifiable account on each read", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-agy-quota-")); roots.push(root);
    const command = join(root, "agy");
    const calls = join(root, "calls");
    writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(process.argv[2]==='models'?'gemini\\tGemini':${JSON.stringify(JSON.stringify(usage))});`, { mode: 0o755 });
    const first = await readAgyQuota({ command });
    const second = await readAgyQuota({ command });
    expect(first).toMatchObject({ status: "available" });
    expect(first?.sourceEpoch).not.toBe(second?.sourceEpoch);
    expect(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([["models"], ["-p", "/usage", "--output-format", "json"], ["models"], ["-p", "/usage", "--output-format", "json"]]);
    writeFileSync(command, `#!${process.execPath}\nconsole.log('Sign in required');`, { mode: 0o755 });
    expect(await readAgyQuota({ command })).toMatchObject({ status: "error", code: "unauthorized" });
  });

  it.skipIf(process.platform === "win32")("bounds a hanging command and returns after process cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-agy-quota-timeout-")); roots.push(root);
    const command = join(root, "agy");
    const pidFile = join(root, "pid");
    writeFileSync(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
    expect(await readAgyQuota({ command, timeoutMs: 500 })).toMatchObject({ status: "error", code: "unavailable" });
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  });

  it("classifies structured ERROR payloads from parseAgyQuota without collapsing them into invalid_response", () => {
    const epoch = "A".repeat(22);
    expect(parseAgyQuota({
      status: "ERROR",
      error: "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
    }, epoch)).toEqual({ status: "error", sourceEpoch: epoch, code: "provider_error", retryable: false });
    expect(parseAgyQuota({
      status: "ERROR",
      error: "Authentication required: please sign in again",
    }, epoch)).toEqual({ status: "error", sourceEpoch: epoch, code: "unauthorized", retryable: false });
    expect(parseAgyQuota({
      status: "ERROR",
      error: "dial tcp: lookup cloudcode-pa.googleapis.com: ECONNREFUSED",
    }, epoch)).toEqual({ status: "error", sourceEpoch: epoch, code: "network", retryable: true });
    expect(parseAgyQuota({
      status: "ERROR",
      error: "HTTP 429 Too Many Requests: rate limit exceeded",
    }, epoch)).toEqual({ status: "error", sourceEpoch: epoch, code: "provider_error", retryable: true });
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "region eligibility rejection on exit 1",
      exitCode: 1,
      stdout: JSON.stringify({
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
        num_turns: 0,
      }),
      stderr: "error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.",
      expected: { status: "error", code: "provider_error", retryable: false },
    },
    {
      name: "auth failure on exit 1",
      exitCode: 1,
      stdout: JSON.stringify({ status: "ERROR", error: "Not authenticated. Sign in required." }),
      stderr: "",
      expected: { status: "error", code: "unauthorized", retryable: false },
    },
    {
      name: "network failure on exit 1",
      exitCode: 1,
      stdout: "",
      stderr: "error: fetch failed: ECONNREFUSED 127.0.0.1:7897",
      expected: { status: "error", code: "network", retryable: true },
    },
    {
      name: "rate limit on exit 1",
      exitCode: 1,
      stdout: JSON.stringify({ status: "ERROR", error: "Upstream service unavailable (503)" }),
      stderr: "",
      expected: { status: "error", code: "provider_error", retryable: true },
    },
    {
      name: "malformed JSON on exit 0",
      exitCode: 0,
      stdout: "not-valid-json",
      stderr: "",
      expected: { status: "error", code: "invalid_response", retryable: true },
    },
    {
      name: "opaque CLI crash on exit 1",
      exitCode: 1,
      stdout: "",
      stderr: "fatal: segmentation fault",
      expected: { status: "error", code: "unavailable", retryable: true },
    },
  ])("surfaces structured quota error for $name", async ({ exitCode, stdout, stderr, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "alook-agy-quota-err-")); roots.push(root);
    const command = join(root, "agy");
    writeFileSync(
      command,
      `#!${process.execPath}
if (process.argv[2] === 'models') {
  console.log('gemini\\tGemini');
  process.exit(0);
}
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)} + '\\n');
if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)} + '\\n');
process.exit(${exitCode});
`,
      { mode: 0o755 },
    );
    expect(await readAgyQuota({ command })).toMatchObject(expected);
  });
});
