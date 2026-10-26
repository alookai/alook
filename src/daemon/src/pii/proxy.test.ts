import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialBroker, startCredentialProxy } from "../credentials/credentialProxy.js";
import { PiiStore } from "./store.js";
import { LOCAL_PII_PATH } from "./proxy.js";
import { createProxyServerApi } from "../cli/proxyServerApi.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(withPii = true, reply?: { status?: number; body?: string; abort?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "pii-proxy-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const seen: { body: Record<string, unknown>; headers: Record<string, unknown>; path: string }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, headers: req.headers, path: req.url! });
    res.setHeader("content-type", "application/json");
    res.statusCode = reply?.status ?? 200;
    if (reply?.abort) { res.write('{"state":"sent","message":'); setImmediate(() => res.destroy()); return; }
    if (reply?.body !== undefined) { res.end(reply.body); return; }
    res.end(JSON.stringify({ state: "sent", message: { seq: "#1", channel: "/test#1234/general" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const store = new PiiStore(join(directory, "state"));
  cleanup.push(() => store.close());
  const broker = new CredentialBroker({ upstreamBaseUrl: `http://127.0.0.1:${address.port}`, voucherDir: join(directory, "vouchers") });
  const a = broker.mint("a", "launch-a", ["send", "read"], "synthetic-a");
  const b = broker.mint("b", "launch-b", ["send", "read"], "synthetic-b");
  const proxy = await startCredentialProxy(broker, withPii ? { pii: store } : {});
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
  const receipt = await api.send(body);
  expect(receipt).toMatchObject({ state: "sent", pii: { triggeredFilters: [{ id: "builtin.emails", name: "Email addresses" }] } });
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
  expect(store.list("a").plugins).toHaveLength(6);
  expect(store.list("b").plugins).toHaveLength(5);
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


it("rejects unsupported encodings and malformed JSON before contacting upstream", async () => {
  const { proxy, a, seen } = await fixture();
  for (const [headers, body] of [
    [{}, "PRIVATE_BODY"],
    [{ "content-type": "text/plain" }, "{}"],
    [{ "content-type": "application/json", "content-encoding": "gzip" }, "{}"],
    [{ "content-type": "application/json" }, "{PRIVATE_BODY"],
    [{ "content-type": "application/json" }, "null"],
    [{ "content-type": "application/json" }, "[]"],
  ] as const) {
    const response = await fetch(`${proxy.url}/api/community/channels/resolve/messages`, {
      method: "POST", headers: { ...headers, authorization: `Bearer ${a.voucher}` }, body: Buffer.from(body),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "PII_INVALID_REQUEST", code: "PII_INVALID_REQUEST" });
  }
  expect(seen).toEqual([]);
});

it("rejects invalid message content but permits an attachment without text", async () => {
  const { request, seen } = await fixture();
  for (const content of [undefined, null, [], "PRIVATE_BODY", { text: 17 }]) {
    expect((await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content })).status).toBe(422);
  }
  expect(seen).toEqual([]);
  expect((await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: {}, attachments: ["file"] })).status).toBe(200);
  expect(seen[0]!.body.content).toEqual({ text: "" });
  expect(seen[0]!.body.attachments).toEqual(["file"]);
});

it("returns a safe unavailable error when no local PII handler exists or the handler fails", async () => {
  const missing = await fixture(false);
  const get = (f: Awaited<ReturnType<typeof fixture>>) => fetch(`${f.proxy.url}${LOCAL_PII_PATH}`, { headers: { authorization: `Bearer ${f.a.voucher}` } });
  expect(await (await get(missing)).json()).toEqual({ error: "PII_UNAVAILABLE", code: "PII_UNAVAILABLE" });
  const available = await fixture();
  vi.spyOn(available.store, "local").mockRejectedValueOnce(new Error("PRIVATE_FAILURE"));
  expect(await (await get(available)).json()).toEqual({ error: "PII_UNAVAILABLE", code: "PII_UNAVAILABLE" });
  expect(missing.seen).toEqual([]);
  expect(available.seen).toEqual([]);
});


it("filters multinational IDs over the actual send transport and preserves unlabeled ordinary references", async () => {
  const { proxy, a, seen, request } = await fixture();
  const text = 'SSN: 219099999; SIN: 123456782; 12345678Z; My Number: 621498320257; order: 219099999.';
  const expected = 'SSN: [REDACTED_ID_CARD]; SIN: [REDACTED_ID_CARD]; [REDACTED_ID_CARD]; My Number: [REDACTED_ID_CARD]; order: 219099999.';
  const body = { channel: "/test#1234/general", nonce: "id-numbers", content: { text } };
  await createProxyServerApi({ proxyUrl: proxy.url, voucher: a.voucher }).send(body);
  expect(seen[0]!.body.content).toEqual({ text: expected });
  expect((await request("/api/community/channels/channel-id/messages", { ...body, nonce: "id-numbers-direct" })).status).toBe(200);
  expect(seen[1]!.body.content).toEqual({ text: expected });
});


it("filters all combined credential classes on the canonical send transport", async () => {
  const { request, seen } = await fixture();
  const text = `-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----; sk-${"a".repeat(24)}; Authorization: Bearer synthetic-token; DB_PASSWORD=aB12345678; postgres://u:pass1234@host/db; order=abc123456789.`;
  const expected = "[REDACTED_PRIVATE_KEY]; [REDACTED_API_KEY]; Authorization: Bearer [REDACTED_TOKEN]; DB_PASSWORD=[REDACTED_SECRET]; postgres://u:[REDACTED_PASSWORD]@host/db; order=abc123456789.";
  expect((await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text }, nonce: "combined-credentials" })).status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.body).toMatchObject({ content: { text: expected }, nonce: "combined-credentials" });
  expect(JSON.stringify(seen)).not.toContain("private material");
  expect(JSON.stringify(seen)).not.toContain("synthetic-token");
  expect(JSON.stringify(seen)).not.toContain("aB12345678");
});


it("omits PII metadata for no-hit sends and lists only enabled filters that trigger", async () => {
  const { request, store } = await fixture();
  const send = (text: string) => request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text } });
  expect(await (await send("ordinary reference")).json()).not.toHaveProperty("pii");
  const receipt = await (await send(`sk_test_${"a".repeat(32)} person@company.cn`)).json();
  expect(receipt.pii).toEqual({ triggeredFilters: [{ id: "builtin.secrets", name: "Keys" }, { id: "builtin.emails", name: "Email addresses" }] });
  await store.manage("a", { action: "setEnabled", pluginId: "builtin.secrets", enabled: false, expectedRevision: 0 });
  expect(await (await send(`sk_test_${"a".repeat(32)}`)).json()).not.toHaveProperty("pii");
});

it("keeps explicit trigger notices after later restoration and supports existing custom string plugins", async () => {
  const { request, store } = await fixture();
  await store.local("a", { action: "add", name: "first", description: "explicit trigger", source: 'export default () => ({text:"changed",triggered:true});' });
  await store.local("a", { action: "add", name: "restore", description: "restore", source: 'export default () => ({text:"original",triggered:false});' });
  const send = () => request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text: "original" } });
  const receipt = await (await send()).json();
  expect(receipt.pii.triggeredFilters.map((filter: { name: string }) => filter.name)).toEqual(["first"]);
  await store.local("a", { action: "add", name: "legacy", description: "stored string plugin", source: 'export default (text: string) => text + " legacy";' });
  expect((await (await send()).json()).pii.triggeredFilters.map((filter: { name: string }) => filter.name)).toEqual(["first", "legacy"]);
});

it.each([
  [200, '{"state":"blocked","reason":"unaligned","unreadCount":1,"latestSeq":2}'],
  [422, '{"error":"denied"}'],
  [503, '{"error":"unavailable"}'],
  [200, 'not JSON'],
  [200, '{"state":"sent"}'],
  [200, JSON.stringify({ state: "sent", message: { channel: "/test#1234/general", seq: "#1" }, padding: "x".repeat(65537) })],
])("preserves upstream status/body without a fabricated notice for status %s", async (status, body) => {
  const { request } = await fixture(true, { status, body });
  const response = await request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text: "person@company.cn" } });
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
});

it("does not report a successful send when the annotated upstream response breaks mid-body", async () => {
  const { request } = await fixture(true, { abort: true });
  await expect(request("/api/community/channels/resolve/messages", { channel: "/test#1234/general", content: { text: "person@company.cn" } }).then(response => response.text())).rejects.toThrow();
});
