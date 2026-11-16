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
});
