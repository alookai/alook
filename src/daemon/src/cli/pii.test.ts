import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PII_SOURCE_MAX_BYTES } from "@alook/shared";
import { CredentialBroker, startCredentialProxy } from "../credentials/credentialProxy.js";
import { PiiStore } from "../pii/store.js";
import { registerPiiCommands } from "./pii.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pii-cli-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new PiiStore(join(directory, "bots"));
  cleanup.push(() => store.close());
  const broker = new CredentialBroker({ upstreamBaseUrl: "http://127.0.0.1:9", voucherDir: join(directory, "vouchers") });
  const voucher = broker.mint("old-bot", "launch", ["send", "read"], "synthetic-key");
  const proxy = await startCredentialProxy(broker, { pii: store });
  cleanup.push(() => proxy.close());
  const token = join(directory, "token");
  writeFileSync(token, `${voucher.voucher}\n`, { mode: 0o600 });
  vi.stubEnv("ALOOK_PROXY_URL", `${proxy.url}///`);
  vi.stubEnv("ALOOK_PROXY_TOKEN_FILE", token);
  const run = async (...args: string[]) => {
    const output = vi.fn();
    const program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} });
    registerPiiCommands(program, output);
    await program.parseAsync(["node", "alook", "pii", ...args]);
    return output;
  };
  return { directory, store, run };
}

it("lists defaults and appends a working local TS filter only to the voucher-bound bot", async () => {
  const { directory, store, run } = await fixture();
  const listed = await run("list");
  expect(listed).toHaveBeenCalledWith({ success: expect.objectContaining({ revision: 0, plugins: expect.any(Array) }) });
  expect(store.list("old-bot").plugins).toHaveLength(5);
  const source = join(directory, "project.ts");
  writeFileSync(source, 'export default (text: string) => text.replace("PROJECT", "[INTERNAL]");');
  const added = await run("add", "--file", source, "--description", "Hide the project name");
  expect(added).toHaveBeenCalledWith({ success: expect.objectContaining({ revision: 1 }) });
  expect(store.list("old-bot").plugins.at(-1)).toMatchObject({ name: "project", description: "Hide the project name", enabled: true });
  expect(await store.filter("old-bot", "PROJECT person@company.cn")).toBe("[INTERNAL] [REDACTED_EMAIL]");
  expect(store.list("other-bot").plugins).toHaveLength(5);
  expect(JSON.stringify([listed.mock.calls, added.mock.calls])).not.toContain("export default");
});

it.each(["ALOOK_PROXY_URL", "ALOOK_PROXY_TOKEN_FILE"])("rejects a missing %s before making a request", async name => {
  const { run } = await fixture();
  vi.stubEnv(name, undefined);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(run("list")).rejects.toThrow("PII requires the running bot's local daemon proxy");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects an oversized source before sending it to the daemon", async () => {
  const { directory, run } = await fixture();
  const source = join(directory, "oversized.ts");
  writeFileSync(source, "x".repeat(PII_SOURCE_MAX_BYTES + 1));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(run("add", "--file", source, "--description", "Too large")).rejects.toThrow("PII_SOURCE_TOO_LARGE");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [{ code: "PII_PLUGIN_LIMIT", error: "PRIVATE_RESPONSE" }, "PII_PLUGIN_LIMIT"],
  [null, "PII_UNAVAILABLE"],
  ["PRIVATE_RESPONSE", "PII_UNAVAILABLE"],
  [{ code: 17, error: "PRIVATE_RESPONSE" }, "PII_UNAVAILABLE"],
])("returns only a safe code for a rejected proxy response %#", async (body, code) => {
  const { run } = await fixture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 422 })));
  await expect(run("list")).rejects.toMatchObject({ message: code, code });
});

it("does not accept invalid success payloads or expose mutation commands", async () => {
  const { run } = await fixture();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: "invalid", plugins: [] })));
  vi.stubGlobal("fetch", fetch);
  await expect(run("list")).rejects.toThrow();
  fetch.mockClear();
  await expect(run("remove", "--plugin", "builtin.emails")).rejects.toMatchObject({ code: "commander.unknownCommand" });
  expect(fetch).not.toHaveBeenCalled();
});
