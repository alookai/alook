import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialBroker, startCredentialProxy } from "../credentials/credentialProxy.js";
import { PiiStore } from "./store.js";
import { LOCAL_PII_PATH } from "./proxy.js";
import { createProxyServerApi } from "../cli/proxyServerApi.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pii-proxy-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const seen: { body: Record<string, unknown>; headers: Record<string, unknown>; path: string }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, headers: req.headers, path: req.url! });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ state: "sent", message: { seq: "#1", channel: "/test#1234/general" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const store = new PiiStore(join(directory, "state"));
  const broker = new CredentialBroker({ upstreamBaseUrl: `http://127.0.0.1:${address.port}`, voucherDir: join(directory, "vouchers") });
  const a = broker.mint("a", "launch-a", ["send", "read"], "synthetic-a");
  const b = broker.mint("b", "launch-b", ["send", "read"], "synthetic-b");
  const proxy = await startCredentialProxy(broker, { pii: store });
  cleanup.push(() => proxy.close());
  const request = (path: string, body: unknown, voucher = a.voucher) => fetch(`${proxy.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${voucher}` }, body: JSON.stringify(body),
  });
  return { store, proxy, a, b, seen, request };
}

it("filters the real CLI API transport and direct canonical POST, preserving the send envelope and UTF-8 length", async () => {
  const { proxy, a, seen, request } = await fixture();
  const body = { agentId: "a", channel: "/test#1234/general", content: { text: "给 person@company.cn 发消息", extra: "keep" }, nonce: "stable", replyToSeq: 4, attachments: ["existing-file"], force: true };
  const api = createProxyServerApi({ proxyUrl: proxy.url, voucher: a.voucher });
  await api.send(body);
  expect(seen[0]!.body).toEqual({ ...body, agentId: undefined, content: { text: "给 [REDACTED_EMAIL] 发消息", extra: "keep" } });
  expect(Number(seen[0]!.headers["content-length"])).toBe(Buffer.byteLength(JSON.stringify(seen[0]!.body)));
  expect(seen[0]!.headers["transfer-encoding"]).toBeUndefined();
  expect(seen[0]!.headers["x-agent-id"]).toBe("a");
  expect((await request("/api/community/channels/channel-id/messages", body)).status).toBe(200);
  expect(JSON.stringify(seen)).not.toContain("person@company.cn");
});

it("binds local list/add to voucher identity and never exposes remove/disable/upsert or owner routes", async () => {
  const { request, store, a, b, seen, proxy } = await fixture();
  for (const action of ["remove", "setEnabled", "update"]) {
    expect((await request(LOCAL_PII_PATH, { action, botId: "b", pluginId: "builtin.emails", enabled: false })).status).toBe(422);
  }
  expect((await request(LOCAL_PII_PATH, { action: "add", botId: "b", name: "wrong", description: "cross bot", source: "export default (x: string) => x" })).status).toBe(422);
  const response = await request(LOCAL_PII_PATH, { action: "add", name: "append", description: "append x", source: 'export default (text: string) => text + "x";' });
  expect(response.status).toBe(200);
  expect(store.list("a").plugins).toHaveLength(9);
  expect(store.list("b").plugins).toHaveLength(8);
  expect((await request("/api/community/bots/b/pii", { action: "remove" })).status).toBe(403);
  expect((await request("/api/community/bots/a/pii", { action: "list" }, b.voucher)).status).toBe(403);
  expect((await fetch(`${proxy.url}${LOCAL_PII_PATH}`, { headers: { authorization: `Bearer ${a.voucher}` } })).status).toBe(200);
  expect(seen).toEqual([]);
});

it("blocks failures, empty output, invalid/oversized input and oversized UTF-8 output before any upstream request", async () => {
  const { store, request, seen } = await fixture();
  const source = 'export default (text: string) => { if(text === "throw-secret") throw new Error(text); if(text === "expand") return "中".repeat(400); if(text === "erase") return ""; return text; };';
  await store.local("a", { action: "add", name: "failure", description: "synthetic behavior", source });
  for (const text of ["throw-secret", "expand", "erase"]) {
    const response = await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text } });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(text);
  }
  expect((await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text: "x".repeat(70_000) } })).status).toBe(422);
  expect(seen).toEqual([]);
  expect((await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text: "erase" }, attachments: ["file"] })).status).toBe(200);
  expect(seen[0]!.body.content).toEqual({ text: "" });
});
