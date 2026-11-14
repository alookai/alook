import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialBroker, startCredentialProxy } from "../credentials/credentialProxy.js";
import { appendMemoryCommit, LOCAL_MEMORY_COMMIT_PATH } from "./commit.js";
import type { LocalCommitResult } from "./proxy.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(reset = vi.fn(async () => {})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-proxy-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broker = new CredentialBroker({ upstreamBaseUrl: "http://127.0.0.1:1", voucherDir: path.join(dir, "vouchers") });
  const registration = broker.mint("bot", "launch", ["send"], "synthetic-runner");
  const voucher = registration.voucher;
  const commit = vi.fn((identity: { agentId: string; launchId: string }, input: { log: string; reset: boolean }): LocalCommitResult => {
    expect(identity.agentId).toBe("bot"); expect(identity.launchId).toBe("launch");
    const entry = appendMemoryCommit(dir, input);
    return { no: entry.no, reset: input.reset, ...(input.reset ? { resetSession: reset } : {}) };
  });
  const errors = vi.fn();
  const proxy = await startCredentialProxy(broker, { onMemoryCommit: commit, onMemoryCommitResetError: errors });
  cleanups.push(() => proxy.close());
  const agent = new http.Agent({ keepAlive: true }); cleanups.push(() => agent.destroy());
  async function request(value: unknown, token = voucher, route = LOCAL_MEMORY_COMMIT_PATH) {
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(proxy.url + route, { method: "POST", agent, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
        const parts: Buffer[] = []; res.on("data", (part) => parts.push(part)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(parts).toString()) }));
      });
      req.on("error", reject); req.end(JSON.stringify(value));
    });
  }
  return { dir, broker, voucher, tokenFile: registration.voucherFile, proxy, commit, reset, errors, agent, request };
}

describe("authenticated local memory commit", () => {
  it.each([false, true])("runs the real CLI and flushes its receipt before reset (reset=%s)", async (resetMode) => {
    let output = "";
    const reset = vi.fn(async () => { expect(JSON.parse(output)).toEqual({ success: { committed: true, no: 0, reset: true } }); });
    const s = await setup(reset);
    const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href, fileURLToPath(new URL("../cli/index.ts", import.meta.url)), "commit", "--stdin", ...(resetMode ? [] : ["--no-reset"])], {
      env: { ...process.env, ALOOK_PROXY_URL: s.proxy.url, ALOOK_PROXY_TOKEN_FILE: s.tokenFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end("I reviewed the original decisions.\nThe remaining source is noted.\n");
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(stderr).toBe(""); expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ success: { committed: true, no: 0, reset: resetMode } });
    if (resetMode) await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    else expect(reset).not.toHaveBeenCalled();
    expect(s.errors).not.toHaveBeenCalled();
  });
  it("rejects the removed remote nap endpoint instead of silently forwarding it", async () => {
    const s = await setup();
    const result = await s.request({ handoff: "obsolete" }, s.voucher, "/api/community/bots/me/nap");
    expect(result.status).toBe(410); expect(result.body.code).toBe("command_removed");
    expect(s.commit).not.toHaveBeenCalled(); expect(s.reset).not.toHaveBeenCalled();
  });
  it("uses voucher identity, stays local, and preserves the session in no-reset mode", async () => {
    const s = await setup();
    expect(await s.request({ log: "I checked the source.\n", reset: false })).toEqual({ status: 200, body: { committed: true, no: 0, reset: false } });
    s.agent.destroy(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.reset).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, ".commits.jsonl"), "utf8"))).toMatchObject({ no: 0, log: "I checked the source.\n", reset: false });
  });
  it("delivers the receipt before resetting on caller connection close", async () => {
    const s = await setup();
    const result = await s.request({ log: "I finished reviewing.", reset: true });
    expect(result.body).toEqual({ committed: true, no: 0, reset: true });
    expect(s.reset).not.toHaveBeenCalled();
    s.agent.destroy();
    await vi.waitFor(() => expect(s.reset).toHaveBeenCalledOnce());
  });
  it("keeps the saved record and reports a reset failure", async () => {
    const s = await setup(vi.fn(async () => { throw new Error("stop failed"); }));
    await s.request({ log: "I reviewed.", reset: true }); s.agent.destroy();
    await vi.waitFor(() => expect(s.errors).toHaveBeenCalledWith("bot", expect.objectContaining({ message: "stop failed" })));
    expect(fs.existsSync(path.join(s.dir, ".commits.jsonl"))).toBe(true);
  });
  it("rejects invalid credentials, forged targets and oversize logs without writing or resetting", async () => {
    const s = await setup();
    expect((await s.request({ log: "ok", reset: true }, "invalid")).status).toBe(401);
    const readOnly = s.broker.mint("bot", "read", ["read"], "synthetic-runner").voucher;
    expect((await s.request({ log: "ok", reset: true }, readOnly)).status).toBe(403);
    for (const body of [{ log: "ok", reset: true, agentId: "foreign" }, { log: "🎉".repeat(6145), reset: true }]) expect((await s.request(body)).status).toBe(400);
    expect(s.commit).not.toHaveBeenCalled(); expect(s.reset).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(s.dir, ".commits.jsonl"))).toBe(false);
  });
  it("does not reset when append fails and assigns distinct numbers for concurrent requests", async () => {
    const s = await setup(); const file = path.join(s.dir, ".commits.jsonl"); fs.mkdirSync(file);
    expect((await s.request({ log: "I reviewed.", reset: true })).status).toBe(400);
    expect(s.reset).not.toHaveBeenCalled(); fs.rmdirSync(file);
    const replies = await Promise.all(Array.from({ length: 8 }, (_, n) => s.request({ log: `I checked source ${n}.`, reset: false })));
    expect(replies.map((r) => r.body.no).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
