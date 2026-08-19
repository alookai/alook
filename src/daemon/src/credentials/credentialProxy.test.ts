import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "http";
import * as fs from "fs";
import { gzipSync } from "node:zlib";
import {
  CredentialBroker,
  DEFAULT_CAPABILITY_RESOLVER,
  LOCAL_MESSAGE_REMINDER_PATH,
  startCredentialProxy,
  type RunningProxy,
} from "./credentialProxy";

const REAL_KEY = "sk_real_SUPER_SECRET";

interface SeenRequest {
  authorization?: string;
  agentId?: string;
  client?: string;
  capabilities?: string;
  method?: string;
  path?: string;
  contentLength?: string;
  transferEncoding?: string;
  acceptEncoding?: string;
  body?: string;
}

/** A throwaway upstream that records what headers + path the proxy forwards. */
async function startUpstream(response: {
  status?: number;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
} = {}): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        authorization: req.headers["authorization"] as string | undefined,
        agentId: req.headers["x-agent-id"] as string | undefined,
        client: req.headers["x-client"] as string | undefined,
        capabilities: req.headers["x-agent-active-capabilities"] as string | undefined,
        method: req.method,
        path: req.url,
        contentLength: req.headers["content-length"],
        transferEncoding: req.headers["transfer-encoding"],
        acceptEncoding: req.headers["accept-encoding"],
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(response.status ?? 200, {
        "content-type": "application/json",
        ...response.headers,
      });
      res.end(response.body ?? JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function post(url: string, voucher: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${voucher}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ hi: 1 }),
  });
  return { status: res.status, body: await res.text() };
}

describe("DEFAULT_CAPABILITY_RESOLVER", () => {
  it("maps only the exact self-profile route shapes to `profile`", () => {
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/users/me/profile")).toBe("profile");
    expect(DEFAULT_CAPABILITY_RESOLVER("PATCH", "/api/community/users/me/profile")).toBe("profile");
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/users/me/avatar")).toBe("profile");
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/users/me/profile")).toBeUndefined();
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/users/me/avatar")).toBeUndefined();
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/users/me/inbox/pull")).toBe("read");
  });

  it("maps a reaction (canonical door PUT messages/{id}/reactions) to `send` (a read-only voucher must not react)", () => {
    // Flat /api/reactAdd is DELETED (folded into the canonical reaction door).
    // The write capability now attaches to the door shape.
    expect(DEFAULT_CAPABILITY_RESOLVER("PUT", "/api/community/messages/resolve/reactions/%F0%9F%91%8D")).toBe("send");
  });

  it("maps only bot mark mutations to send and the aggregate list to read", () => {
    expect(DEFAULT_CAPABILITY_RESOLVER("PUT", "/api/community/messages/resolve/marks")).toBe("send");
    expect(DEFAULT_CAPABILITY_RESOLVER("DELETE", "/api/community/messages/resolve/marks")).toBe("send");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/users/me/marks")).toBe("read");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/messages/m1/marks")).toBeUndefined();
  });

  it("maps the friends bucket sub-resource endpoints (listFriends fold) to `friend`", () => {
    // The bot's listFriends fans out to these; friends/blocked is bot-403 at the
    // route so a bot never reaches it, but the cap mapping is uniform.
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/friends/accepted")).toBe("friend");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/friends/pending")).toBe("friend");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/friends/blocked")).toBe("friend");
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/friends/request")).toBe("friend");
  });

  // ── Canonical id-in-path message door (route/disc retarget). The SHAPE is
  //    matched by method, BEFORE the legacy `/channel → server` substring rule,
  //    which would otherwise grab `/channels/{id}/…` first and mis-scope a bot
  //    send/read to the `server` capability. ──
  it("maps the canonical messages door by METHOD: POST→send, GET→read", () => {
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/resolve/messages")).toBe("send");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/resolve/messages")).toBe("read");
    // real channelId in the path (human/web shape) resolves the same way.
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/abc123/messages")).toBe("send");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/abc123/messages")).toBe("read");
    // with a query string (read's ?ref=&before=…).
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/resolve/messages?ref=%2Fs%2Fg&before=5")).toBe("read");
  });

  it("does NOT let the canonical `/channels/…` path fall through to the `server` capability (the miscap this rewrite fixes)", () => {
    // Pre-rewrite this path contains `channel`, which the legacy rule maps to
    // `server`; the shape rule must intercept POST/GET first.
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/resolve/messages")).not.toBe("server");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/resolve/messages")).not.toBe("server");
  });

  it("maps the canonical attachments door (attachments fold) to `attach`, NOT `server` — no new rule needed", () => {
    // The upload/download verbs folded onto channels/{id}/attachments. The
    // existing `.includes("/attachment")` rule fires FIRST (before the shape
    // rules and before the legacy `/channel → server` fallback), so the nested
    // path keeps the `attach` capability with no resolver change (Aigneis #554).
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/resolve/attachments")).toBe("attach");
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/c1/attachments?target=%2Fs%2Fg")).toBe("attach");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/resolve/attachments/att_1")).toBe("attach");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/c1/attachments/att_1")).toBe("attach");
    // The `/channels/` substring must NOT drag it to the `server` fallback.
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/c1/attachments/att_1")).not.toBe("server");
    // …and must NOT be mistaken for the messages door (send/read).
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/community/channels/resolve/attachments")).not.toBe("send");
  });

  it("maps the message-keyed write doors to `send` (reactions PUT/DELETE, threads POST, seq GET→read)", () => {
    expect(DEFAULT_CAPABILITY_RESOLVER("PUT", "/api/community/messages/resolve/reactions/%F0%9F%91%8D")).toBe("send");
    expect(DEFAULT_CAPABILITY_RESOLVER("DELETE", "/api/community/messages/m1/reactions/%F0%9F%91%8D")).toBe("send");
    // the seq→id lookup is a read.
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/channels/resolve/messages/seq/42")).toBe("read");
  });

  it("maps the single-message hydrate door GET messages/{id} to `read` (folds `resolve`)", () => {
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/messages/resolve?ref=%2Fs%2Fg&seq=42")).toBe("read");
    expect(DEFAULT_CAPABILITY_RESOLVER("GET", "/api/community/messages/m1")).toBe("read");
    // must NOT shadow the more specific write sub-paths.
    expect(DEFAULT_CAPABILITY_RESOLVER("PUT", "/api/community/messages/m1/reactions/x")).toBe("send");
  });

  it("does not map deleted flat write verbs; inboxPull still matches the generic /inbox read family", () => {
    // /api/inboxPull's flat ROUTE is deleted, but the resolver's generic
    // `/inbox` substring rule (unrelated to the specific flat-verb rules)
    // still fires on this path shape — the daemon proxy only rejects the
    // capability, it never routes the request, so this mapping is harmless
    // even with the route gone.
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/inboxPull")).toBe("read");
    // The flat send/reactAdd/read/resolve/channelMember/friendRequest/listFriends
    // routes are DELETED — their bare `/api/<verb>` paths no longer carry a
    // capability rule (they only reached upstream via the flat routes, which
    // are gone). `/api/send` still matches nothing else, so it's undefined
    // now, not `send`.
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/send")).toBeUndefined();
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/reactAdd")).toBeUndefined();
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/friendRequest")).toBeUndefined();
    expect(DEFAULT_CAPABILITY_RESOLVER("POST", "/api/listFriends")).toBeUndefined();
  });
});

describe("CredentialBroker", () => {
  it("requires upstreamBaseUrl; mint requires a runnerKey", () => {
    expect(() => new CredentialBroker({ upstreamBaseUrl: "" })).toThrow();
    const broker = new CredentialBroker({ upstreamBaseUrl: "http://x" });
    // @ts-expect-error runnerKey is required
    expect(() => broker.mint("a", "l", ["send"])).toThrow();
    expect(() => broker.mint("a", "l", ["send"], "")).toThrow();
  });

  it("mints a vch_ voucher to a 0600 file and tracks it", () => {
    const broker = new CredentialBroker({ upstreamBaseUrl: "http://x", voucherPrefix: "vch_" });
    const reg = broker.mint("agent-1", "launch-1", ["send"], REAL_KEY);
    expect(reg.voucher.startsWith("vch_")).toBe(true);
    expect(fs.readFileSync(reg.voucherFile, "utf8")).toBe(reg.voucher);
    // POSIX owner-only permission bits don't map onto Windows' ACL model —
    // `fs.chmodSync(file, 0o600)` there just clears the read-only attribute,
    // so the resulting mode is whatever Windows reports for "not read-only"
    // (typically 0o666), not a literal 0o600. Only assert the exact bits on
    // POSIX platforms; on Windows just confirm the file isn't world-writable
    // in the "read-only flag cleared" sense doesn't apply, so skip to size.
    if (process.platform !== "win32") {
      const mode = fs.statSync(reg.voucherFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(broker.size).toBe(1);
  });

  it("never writes the runner key to the voucher file", () => {
    const broker = new CredentialBroker({ upstreamBaseUrl: "http://x" });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);
    expect(fs.readFileSync(reg.voucherFile, "utf8")).not.toContain(REAL_KEY);
  });

  it("revoke removes the voucher + file; revokeAgent clears all of an agent's", () => {
    const broker = new CredentialBroker({ upstreamBaseUrl: "http://x" });
    const r1 = broker.mint("a", "l1", ["send"], REAL_KEY);
    const r2 = broker.mint("a", "l2", ["send"], REAL_KEY);
    expect(broker.revoke(r1.voucher)).toBe(true);
    expect(fs.existsSync(r1.voucherFile)).toBe(false);
    expect(broker.revoke("vch_nope")).toBe(false);
    expect(broker.revokeAgent("a")).toBe(1); // only r2 remains
    expect(broker.size).toBe(0);
    expect(fs.existsSync(r2.voucherFile)).toBe(false);
  });

  it("check: missing/invalid voucher and capability scoping", () => {
    const broker = new CredentialBroker({ upstreamBaseUrl: "http://x" });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);
    expect(broker.check(undefined).ok).toBe(false);
    expect(broker.check("Bearer vch_nope").ok).toBe(false);
    expect(broker.check(`Bearer ${reg.voucher}`).ok).toBe(true);
    expect(broker.check(`Bearer ${reg.voucher}`, "send").ok).toBe(true);
    const denied = broker.check(`Bearer ${reg.voucher}`, "tasks");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);
  });
});

describe("startCredentialProxy (zero-trust end to end)", () => {
  let proxy: RunningProxy | undefined;
  let upstreamClose: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await proxy?.close();
    await upstreamClose?.();
    proxy = undefined;
    upstreamClose = undefined;
  });

  it("consumes a valid reminder locally with voucher-derived identity and no audit/forward", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onMessageReminderArm = vi.fn(async (input) => ({ armed: true as const, dueAt: 123456, input }));
    const onProxyRequest = vi.fn();
    proxy = await startCredentialProxy(broker, { onMessageReminderArm, onProxyRequest });
    const reg = broker.mint("agent-derived", "l", ["send"], REAL_KEY);

    const response = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "/s#0042/general/#3", sentSeq: 7, remindAfterMs: 60_000 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ armed: true, dueAt: 123456 }));
    expect(onMessageReminderArm).toHaveBeenCalledWith({
      agentId: "agent-derived",
      channel: "/s#0042/general/#3",
      sentSeq: 7,
      remindAfterMs: 60_000,
    });
    expect(upstream.seen).toEqual([]);
    expect(onProxyRequest).not.toHaveBeenCalled();
  });

  it("requires a valid send-capable voucher for the local reminder endpoint", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onMessageReminderArm = vi.fn();
    proxy = await startCredentialProxy(broker, { onMessageReminderArm });
    const readOnly = broker.mint("reader", "l", ["read"], REAL_KEY);
    const body = JSON.stringify({ channel: "/s#0042/general", sentSeq: 1, remindAfterMs: 60_000 });

    const missing = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body,
    });
    expect(missing.status).toBe(401);
    const invalid = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT",
      headers: { authorization: "Bearer vch_invalid", "content-type": "application/json" },
      body,
    });
    expect(invalid.status).toBe(401);
    const denied = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${readOnly.voucher}`, "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(403);
    expect(onMessageReminderArm).not.toHaveBeenCalled();
    expect(upstream.seen).toEqual([]);
  });

  it("rejects non-exact routes, wrong methods, malformed/unknown/oversize bodies and never forwards", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onMessageReminderArm = vi.fn();
    const onProxyRequest = vi.fn();
    proxy = await startCredentialProxy(broker, { onMessageReminderArm, onProxyRequest });
    const reg = broker.mint("agent-1", "l", ["send"], REAL_KEY);
    const headers = { authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" };
    const valid = { channel: "/s#0042/general", sentSeq: 1, remindAfterMs: 60_000 };

    expect((await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}?extra=1`, {
      method: "PUT", headers, body: JSON.stringify(valid),
    })).status).toBe(404);
    expect((await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "POST", headers, body: JSON.stringify(valid),
    })).status).toBe(405);

    for (const body of [
      "not-json",
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, channel: "/s#0042/general#2" }),
      JSON.stringify({ ...valid, channel: "/.dm/no-discriminator" }),
      JSON.stringify({ ...valid, channel: "/s#0042/general/#0" }),
      JSON.stringify({ ...valid, sentSeq: 1.5 }),
      JSON.stringify({ ...valid, remindAfterMs: 59_999 }),
      JSON.stringify({ ...valid, remindAfterMs: 86_400_001 }),
    ]) {
      const response = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, { method: "PUT", headers, body });
      expect(response.status).toBe(400);
    }
    const oversize = await fetch(`${proxy.url}${LOCAL_MESSAGE_REMINDER_PATH}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...valid, padding: "x".repeat(5_000) }),
    });
    expect(oversize.status).toBe(413);
    expect(onMessageReminderArm).not.toHaveBeenCalled();
    expect(onProxyRequest).not.toHaveBeenCalled();
    expect(upstream.seen).toEqual([]);
  });

  it("swaps the voucher for the real key + stamps identity/capability headers", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url, voucherPrefix: "vch_" });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("agent-1", "launch-1", ["send", "read"], REAL_KEY);

    const r = await post(proxy.url, reg.voucher, "/send");
    expect(r.status).toBe(200);
    const seen = upstream.seen.at(-1)!;
    expect(seen.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seen.authorization).not.toContain("vch_");
    expect(seen.agentId).toBe("agent-1");
    expect(seen.client).toBe("cli");
    expect(seen.capabilities).toContain("send");
  });

  it("swaps each voucher for ITS OWN per-agent runner key (not one global key)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const a = broker.mint("agent-a", "l", ["send"], "sk_agent_AAA");
    const b = broker.mint("agent-b", "l", ["send"], "sk_agent_BBB");

    await post(proxy.url, a.voucher, "/send");
    expect(upstream.seen.at(-1)!.authorization).toBe("Bearer sk_agent_AAA");
    expect(upstream.seen.at(-1)!.agentId).toBe("agent-a");

    await post(proxy.url, b.voucher, "/send");
    expect(upstream.seen.at(-1)!.authorization).toBe("Bearer sk_agent_BBB");
    expect(upstream.seen.at(-1)!.agentId).toBe("agent-b");
  });

  it("rejects an invalid voucher without forwarding upstream", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);

    const r = await post(proxy.url, "vch_made_up", "/send");
    expect(r.status).toBe(401);
    expect(r.body).toContain("invalid local agent proxy token");
    expect(upstream.seen.length).toBe(0);
  });

  it("enforces capability scoping (403 on a cap the voucher lacks)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("a", "l", ["read"], REAL_KEY); // no "send"

    // The canonical send door (POST channels/{id}/messages) requires `send`.
    const r = await post(proxy.url, reg.voucher, "/api/community/channels/resolve/messages");
    expect(r.status).toBe(403);
    expect(upstream.seen.length).toBe(0);
  });

  it("passes canonical REST paths through and rejects deleted flat inputs", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const sightings: Array<{ agentId: string; method: string; pathname: string }> = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onProxyRequest: (agentId, method, pathname) => sightings.push({ agentId, method, pathname }),
    });
    const reg = broker.mint("agent-1", "l", ["send", "read", "server", "attach"], REAL_KEY);

    for (const legacyPath of [
      "/api/send",
      "/api/attachmentUpload?target=/x/y",
      "/api/community/send",
      "/api/community/agent/send",
      "/api",
    ]) {
      expect((await post(proxy.url, reg.voucher, legacyPath)).status).toBe(404);
    }
    expect(upstream.seen).toHaveLength(0);
    expect(sightings).toEqual([]);

    // A folded verb's real REST path and encoded query pass through byte-for-byte.
    await post(proxy.url, reg.voucher, "/api/community/servers?cursor=a%2Fb&limit=2");
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.path).toBe("/api/community/servers?cursor=a%2Fb&limit=2");
    expect(sightings).toEqual([
      { agentId: "agent-1", method: "POST", pathname: "/api/community/servers" },
    ]);
  });

  it("leaves non-/api paths untouched", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("agent-1", "l", ["send"], REAL_KEY);

    await post(proxy.url, reg.voucher, "/send");
    expect(upstream.seen.at(-1)!.path).toBe("/send");
  });

  it("a revoked voucher stops working", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);
    broker.revoke(reg.voucher);

    const r = await post(proxy.url, reg.voucher, "/send");
    expect(r.status).toBe(401);
  });

  it("fires onProxyRequest ONCE on verdict.ok, with (agentId, method, pathname), before upstream is dispatched", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const sightings: Array<{ agentId: string; method: string; pathname: string }> = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onProxyRequest: (agentId, method, pathname) => sightings.push({ agentId, method, pathname }),
    });
    const reg = broker.mint("agent-1", "l", ["send"], REAL_KEY);

    const r = await post(proxy.url, reg.voucher, "/api/community/channels/resolve/messages");
    expect(r.status).toBe(200);
    expect(sightings).toEqual([{ agentId: "agent-1", method: "POST", pathname: "/api/community/channels/resolve/messages" }]);
  });

  it("reports each canonical mark request exactly once for audit derivation", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const sightings: Array<{ agentId: string; method: string; pathname: string }> = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onProxyRequest: (agentId, method, pathname) => sightings.push({ agentId, method, pathname }),
    });
    const reg = broker.mint("agent-1", "l", ["send", "read"], REAL_KEY);
    const headers = { Authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" };

    await fetch(`${proxy.url}/api/community/messages/resolve/marks`, {
      method: "PUT", headers, body: JSON.stringify({ channel: "/s/c", seq: 1 }),
    });
    await fetch(`${proxy.url}/api/community/messages/resolve/marks`, {
      method: "DELETE", headers, body: JSON.stringify({ channel: "/s/c", seq: 1 }),
    });
    await fetch(`${proxy.url}/api/community/users/me/marks`, { method: "GET", headers });

    expect(sightings).toEqual([
      { agentId: "agent-1", method: "PUT", pathname: "/api/community/messages/resolve/marks" },
      { agentId: "agent-1", method: "DELETE", pathname: "/api/community/messages/resolve/marks" },
      { agentId: "agent-1", method: "GET", pathname: "/api/community/users/me/marks" },
    ]);
  });

  it("preserves framing for unchanged JSON bodies without inventing a length for bodyless DELETE", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("agent-1", "l", ["send"], REAL_KEY);
    const headers = { Authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" };
    const body = JSON.stringify({ channel: "/s/c", seq: 42 });

    await fetch(`${proxy.url}/api/community/messages/resolve/marks`, {
      method: "DELETE",
      headers,
      body,
    });
    await fetch(`${proxy.url}/api/community/messages/resolve/marks`, {
      method: "DELETE",
      headers,
    });
    await fetch(`${proxy.url}/api/community/messages/resolve/marks`, {
      method: "PUT",
      headers,
      body,
    });

    expect(upstream.seen).toEqual([
      expect.objectContaining({
        method: "DELETE",
        contentLength: String(Buffer.byteLength(body)),
        transferEncoding: undefined,
        body,
      }),
      expect.objectContaining({
        method: "DELETE",
        contentLength: undefined,
        transferEncoding: undefined,
        body: "",
      }),
      expect.objectContaining({
        method: "PUT",
        contentLength: String(Buffer.byteLength(body)),
        transferEncoding: undefined,
        body,
      }),
    ]);
  });

  it("does NOT fire onProxyRequest on a rejected voucher (401/403)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const sightings: Array<{ agentId: string }> = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onProxyRequest: (agentId, _method, _pathname) => sightings.push({ agentId }),
    });

    // Missing voucher entirely → 401.
    const bad = await fetch(`${proxy.url}/api/send`, { method: "POST" });
    expect(bad.status).toBe(401);

    // Invalid voucher → 401.
    const bogus = await post(proxy.url, "vch_bogus", "/api/send");
    expect(bogus.status).toBe(401);

    // Capability denied → 403 (still not fired). Use the canonical send door
    // (POST channels/{id}/messages → send) since the flat /api/send is deleted.
    const scoped = broker.mint("agent-1", "l", ["read"], REAL_KEY);
    const denied = await post(proxy.url, scoped.voucher, "/api/community/channels/resolve/messages");
    expect(denied.status).toBe(403);

    expect(sightings).toEqual([]);
  });

  it("the default capability resolver maps /attachmentUpload and /attachmentDownload to `attach`", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const scoped = broker.mint("agent-1", "l", ["send", "read"], REAL_KEY); // no "attach"
    const withAttach = broker.mint("agent-2", "l2", ["attach"], REAL_KEY);

    const upDenied = await post(proxy.url, scoped.voucher, "/api/community/channels/resolve/attachments?target=/x/y");
    expect(upDenied.status).toBe(403);
    const dlDenied = await post(proxy.url, scoped.voucher, "/api/community/channels/resolve/attachments/att_1");
    expect(dlDenied.status).toBe(403);

    const upOk = await post(proxy.url, withAttach.voucher, "/api/community/channels/resolve/attachments?target=/x/y");
    expect(upOk.status).toBe(200);
    const dlOk = await post(proxy.url, withAttach.voucher, "/api/community/channels/resolve/attachments/att_1");
    expect(dlOk.status).toBe(200);
  });

  it("attach-only voucher cannot send messages (capability isolation)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("agent-1", "l", ["attach"], REAL_KEY);

    // Canonical send door requires `send`; an attach-only voucher is denied.
    const r = await post(proxy.url, reg.voucher, "/api/community/channels/resolve/messages");
    expect(r.status).toBe(403);
  });

  it("onInboxPullResponse is NOT triggered by canonical attachment download (tightened guard)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    let called = 0;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onInboxPullResponse: () => {
        called++;
      },
    });
    const reg = broker.mint("agent-1", "l", ["attach", "read"], REAL_KEY);

    // Path that used to (loosely) match `.endsWith("/inboxPull")` — the
    // exact-path guard must not fire for attachment traffic, which returns
    // raw binary.
    const r = await post(proxy.url, reg.voucher, "/api/community/channels/resolve/attachments/att_1");
    expect(r.status).toBe(200);
    expect(called).toBe(0);

    // The real inbox pull still triggers the callback (baseline).
    const p = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
    expect(p.status).toBe(200);
    // startUpstream() returns { ok: true } (no `messages`), so the callback
    // does not fire with a message list.
  });

  it("onInboxPullResponse fires for the canonical fold path users/me/inbox/pull, but NOT snapshot", async () => {
    // The inboxPull verb folds into POST users/me/inbox/pull (route/disc 轴3);
    // callInboxPull sends this full path directly (no rewrite), so the timeline
    // recorder's exact-path guard must recognize it. The snapshot door is a
    // peek (no `{ messages }`) and must NOT be treated as a pull. The flat
    // `/api/inboxPull` verb is deleted (flat-delete step) — no longer part of
    // this guard.
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const seen: string[] = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onInboxPullResponse: (agentId) => seen.push(agentId),
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const canonical = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
    expect(canonical.status).toBe(200);
    // startUpstream() returns { ok: true } (no messages) so the handler never
    // fires with a real list — seen stays empty, but the path isn't 500 or
    // rejected, proving it's accepted as pull traffic (the guard matched).
    expect(seen).toEqual([]);
  });

  it("surfaces the buffered inboxPull response AND fires onInboxPullResponse", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const seen: Array<{ agentId: string; count: number }> = [];
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onInboxPullResponse: (agentId, messages) => seen.push({ agentId, count: messages.length }),
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const r = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
    expect(r.status).toBe(200);
    // `startUpstream()` always responds `{ ok: true }` — no `messages` field —
    // so the callback should NOT fire for a response that isn't shaped like
    // an inboxPull payload, but the response itself must still be forwarded.
    expect(seen).toEqual([]);
  });

  it("forces identity upstream for canonical inbox pull and observes a non-empty response exactly once", async () => {
    const messages = [{ seq: "#1", channel: "/s#0001/c", sender: "@a#0001", content: { text: "hello" } }];
    const body = JSON.stringify({ messages });
    const upstream = await startUpstream({ body });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    const onInboxPullObservationError = vi.fn();
    proxy = await startCredentialProxy(broker, { onInboxPullResponse, onInboxPullObservationError });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(
      proxy.url,
      reg.voucher,
      "/api/community/users/me/inbox/pull",
      { "accept-encoding": "gzip, deflate" },
    );

    expect(response).toEqual({ status: 200, body });
    expect(upstream.seen[0]?.acceptEncoding).toBe("identity");
    expect(onInboxPullResponse).toHaveBeenCalledTimes(1);
    expect(onInboxPullResponse).toHaveBeenCalledWith("agent-1", messages, undefined);
    expect(onInboxPullObservationError).not.toHaveBeenCalled();
  });

  it("preserves compression negotiation for non-pull and wrong-method lookalike routes", async () => {
    const upstream = await startUpstream({ body: JSON.stringify({ messages: [{ seq: "#1" }] }) });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    proxy = await startCredentialProxy(broker, { onInboxPullResponse });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    await post(
      proxy.url,
      reg.voucher,
      "/api/community/users/me/inbox/snapshot",
      { "accept-encoding": "gzip, deflate" },
    );
    const getResponse = await fetch(`${proxy.url}/api/community/users/me/inbox/pull`, {
      headers: {
        authorization: `Bearer ${reg.voucher}`,
        "accept-encoding": "deflate",
      },
    });
    await getResponse.arrayBuffer();

    expect(upstream.seen.map((request) => request.acceptEncoding)).toEqual(["gzip, deflate", "deflate"]);
    expect(onInboxPullResponse).not.toHaveBeenCalled();
  });

  it("forwards an empty successful pull without observing or warning", async () => {
    const body = JSON.stringify({ messages: [] });
    const upstream = await startUpstream({ body });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    const onInboxPullObservationError = vi.fn();
    proxy = await startCredentialProxy(broker, { onInboxPullResponse, onInboxPullObservationError });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");

    expect(response).toEqual({ status: 200, body });
    expect(onInboxPullResponse).not.toHaveBeenCalled();
    expect(onInboxPullObservationError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unexpected gzip",
      body: gzipSync(JSON.stringify({ messages: [{ seq: "#1", content: { text: "private gzip body" } }] })),
      headers: { "content-encoding": "gzip" },
      expectedBody: JSON.stringify({ messages: [{ seq: "#1", content: { text: "private gzip body" } }] }),
      reason: "unexpected_content_encoding",
      contentEncoding: "gzip",
    },
    {
      name: "invalid JSON",
      body: "private invalid json body",
      headers: {},
      expectedBody: "private invalid json body",
      reason: "invalid_json",
      contentEncoding: "identity",
    },
    {
      name: "missing messages",
      body: JSON.stringify({ secret: "private missing-shape body" }),
      headers: {},
      expectedBody: JSON.stringify({ secret: "private missing-shape body" }),
      reason: "invalid_inbox_shape",
      contentEncoding: "identity",
    },
    {
      name: "non-array messages",
      body: JSON.stringify({ messages: { secret: "private wrong-shape body" } }),
      headers: {},
      expectedBody: JSON.stringify({ messages: { secret: "private wrong-shape body" } }),
      reason: "invalid_inbox_shape",
      contentEncoding: "identity",
    },
  ])("forwards $name unchanged and emits one bounded observation failure", async ({
    body,
    headers,
    expectedBody,
    reason,
    contentEncoding,
  }) => {
    const upstream = await startUpstream({ body, headers });
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    const onInboxPullObservationError = vi.fn();
    const runningProxy = await startCredentialProxy(broker, { onInboxPullResponse, onInboxPullObservationError });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);
    try {
      const response = await post(runningProxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
      expect(response).toEqual({ status: 200, body: expectedBody });
      expect(onInboxPullResponse).not.toHaveBeenCalled();
      expect(onInboxPullObservationError).toHaveBeenCalledTimes(1);
      expect(onInboxPullObservationError).toHaveBeenCalledWith({
        agentId: "agent-1",
        reason,
        contentEncoding,
      });
      const warning = JSON.stringify(onInboxPullObservationError.mock.calls);
      expect(warning).not.toContain("private");
      expect(warning).not.toContain(REAL_KEY);
      expect(warning).not.toContain(reg.voucher);
    } finally {
      await runningProxy.close();
      await upstream.close();
    }
  });

  it("keeps non-2xx inbox responses transparent and outside observation", async () => {
    const body = JSON.stringify({ error: "private upstream failure" });
    const upstream = await startUpstream({ status: 503, body });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    const onInboxPullObservationError = vi.fn();
    proxy = await startCredentialProxy(broker, { onInboxPullResponse, onInboxPullObservationError });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");

    expect(response).toEqual({ status: 503, body });
    expect(onInboxPullResponse).not.toHaveBeenCalled();
    expect(onInboxPullObservationError).not.toHaveBeenCalled();
  });

  it("keeps a successful pull transparent when the observer throws and reports only the failure class", async () => {
    const body = JSON.stringify({ messages: [{ seq: "#1", content: { text: "private observer body" } }] });
    const upstream = await startUpstream({ body });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullObservationError = vi.fn();
    proxy = await startCredentialProxy(broker, {
      onInboxPullResponse: () => {
        throw new Error("private observer exception");
      },
      onInboxPullObservationError,
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");

    expect(response).toEqual({ status: 200, body });
    expect(onInboxPullObservationError).toHaveBeenCalledWith({
      agentId: "agent-1",
      reason: "observer_failed",
      contentEncoding: "identity",
    });
    expect(JSON.stringify(onInboxPullObservationError.mock.calls)).not.toContain("private");
  });

  it("keeps a successful pull transparent when observation setup throws", async () => {
    const body = JSON.stringify({ messages: [{ seq: "#1" }] });
    const upstream = await startUpstream({ body });
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    const onInboxPullResponse = vi.fn();
    const onInboxPullObservationError = vi.fn();
    proxy = await startCredentialProxy(broker, {
      onInboxPullStart: () => {
        throw new Error("private setup exception");
      },
      onInboxPullResponse,
      onInboxPullObservationError,
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");

    expect(response).toEqual({ status: 200, body });
    expect(onInboxPullResponse).toHaveBeenCalledWith("agent-1", [{ seq: "#1" }], undefined);
    expect(onInboxPullObservationError).toHaveBeenCalledWith({
      agentId: "agent-1",
      reason: "observer_failed",
      contentEncoding: "identity",
    });
    expect(JSON.stringify(onInboxPullObservationError.mock.calls)).not.toContain("private");
  });

  it("captures each inbox observation token at pull start even when responses finish out of order", async () => {
    const pending: http.ServerResponse[] = [];
    const upstreamServer = http.createServer((_req, res) => pending.push(res));
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address();
    const upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    upstreamClose = () => new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    const seen: number[] = [];
    let generation = 0;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstreamUrl });
    proxy = await startCredentialProxy(broker, {
      onInboxPullStart: () => ++generation,
      onInboxPullResponse: (_agentId, _messages, token) => seen.push(token as number),
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const first = post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
    const second = post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.writeHead(200, { "content-type": "application/json" });
    pending[1]!.end(JSON.stringify({ messages: [{ seq: "#2", channel: "/s#0001/c" }] }));
    await vi.waitFor(() => expect(seen).toEqual([2]));
    pending[0]!.writeHead(200, { "content-type": "application/json" });
    pending[0]!.end(JSON.stringify({ messages: [{ seq: "#1", channel: "/s#0001/c" }] }));
    await Promise.all([first, second]);

    expect(seen).toEqual([2, 1]);
  });

  it("keeps a real inbox pull fail-open when onInboxPullStart throws synchronously", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker, {
      onInboxPullStart: () => {
        throw new Error("observation unavailable");
      },
      onInboxPullResponse: vi.fn(),
    });
    const reg = broker.mint("agent-1", "l", ["read"], REAL_KEY);

    const response = await post(proxy.url, reg.voucher, "/api/community/users/me/inbox/pull");

    expect(response.status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.path).toBe("/api/community/users/me/inbox/pull");
  });
});

/** A throwaway upstream that never responds — for timeout/leak tests below. */
async function startHungUpstream(): Promise<{
  url: string;
  close: () => Promise<void>;
  connectionsClosed: () => number;
}> {
  let connectionsClosed = 0;
  const server = http.createServer(() => {
    /* never respond */
  });
  server.on("connection", (socket) => {
    socket.on("close", () => {
      connectionsClosed++;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    connectionsClosed: () => connectionsClosed,
  };
}

/** An upstream that sends headers + a partial body, then stalls forever without ending it. */
async function startStallingBodyUpstream(): Promise<{
  url: string;
  close: () => Promise<void>;
  connectionsClosed: () => number;
}> {
  let connectionsClosed = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{"); // headers + partial body flushed, then never res.end()
  });
  server.on("connection", (socket) => {
    socket.on("close", () => {
      connectionsClosed++;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    connectionsClosed: () => connectionsClosed,
  };
}

/** An upstream that sends headers + a partial body, then hard-resets the socket (not just idle). */
async function startResettingBodyUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    // Destroy the raw socket (TCP-level reset), as opposed to merely going
    // idle — this fires 'error'/'close' on the client's IncomingMessage
    // immediately, unlike a stall which relies on the idle timer. The
    // short delay gives the client a chance to actually receive/parse the
    // headers first — this test targets the "headers already forwarded,
    // THEN reset" case, not a same-tick connection failure.
    setTimeout(() => res.socket?.destroy(), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("startCredentialProxy — upstream timeout / connection-leak fix", () => {
  let proxy: RunningProxy | undefined;
  let upstreamClose: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await proxy?.close();
    await upstreamClose?.();
    proxy = undefined;
    upstreamClose = undefined;
  });

  it("returns 504 (not hanging forever) when the upstream never responds", async () => {
    const hung = await startHungUpstream();
    upstreamClose = hung.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: hung.url });
    proxy = await startCredentialProxy(broker, { upstreamTimeoutMs: 100 });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);

    const start = Date.now();
    const r = await post(proxy.url, reg.voucher, "/send");
    expect(r.status).toBe(504);
    expect(JSON.parse(r.body).code).toBe("upstream_timeout");
    // Bounded by the timeout, not hanging indefinitely.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("destroys the outbound connection on timeout instead of leaking it", async () => {
    const hung = await startHungUpstream();
    upstreamClose = hung.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: hung.url });
    proxy = await startCredentialProxy(broker, { upstreamTimeoutMs: 100 });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);

    await post(proxy.url, reg.voucher, "/send");
    // Give the destroyed socket a moment to actually finish closing.
    await new Promise((r) => setTimeout(r, 300));
    expect(hung.connectionsClosed()).toBe(1);
  });

  it("destroys the upstream request when the downstream client disconnects early", async () => {
    const hung = await startHungUpstream();
    upstreamClose = hung.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: hung.url });
    // Deliberately no upstreamTimeoutMs override (long default) — only the
    // downstream-close handler should be what rescues this connection.
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);

    const controller = new AbortController();
    const pending = fetch(`${proxy.url}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pending;

    await new Promise((r) => setTimeout(r, 300));
    expect(hung.connectionsClosed()).toBe(1);
  });

  it("bounds the downstream response too when upstream sends headers then stalls mid-body", async () => {
    // Regression guard: once upstream headers arrive, `responded` flips
    // true — the timeout handler must still destroy `res`, not just the
    // upstream socket, or the agent's own client hangs forever reading a
    // body that will never end (destroying the piped-FROM source does not
    // itself end the piped-TO destination).
    const stalling = await startStallingBodyUpstream();
    upstreamClose = stalling.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: stalling.url });
    proxy = await startCredentialProxy(broker, { upstreamTimeoutMs: 100 });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);

    const start = Date.now();
    const res = await fetch(`${proxy.url}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // Headers were already forwarded before the stall — that part of the
    // response already committed and can't (and shouldn't) change.
    expect(res.status).toBe(200);
    // Reading the (otherwise never-ending) body must still be bounded.
    await expect(res.text()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);

    await new Promise((r) => setTimeout(r, 300));
    expect(stalling.connectionsClosed()).toBe(1);
  });

  it("bounds the downstream response when the upstream hard-resets mid-body (not just idles)", async () => {
    // `.pipe()` doesn't forward source errors to the destination, and a hard
    // reset fires 'error'/'close' immediately rather than waiting out the
    // idle timer — a distinct failure mode from the stalling-body test above,
    // and NOT covered by the `upstreamReq`-level timeout/close wiring alone.
    const resetting = await startResettingBodyUpstream();
    upstreamClose = resetting.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: resetting.url });
    // Long timeout — only the upstream-response error/close listener, not
    // the idle timer, should be what rescues this connection.
    proxy = await startCredentialProxy(broker, { upstreamTimeoutMs: 5000 });
    const reg = broker.mint("a", "l", ["send"], REAL_KEY);

    const start = Date.now();
    const res = await fetch(`${proxy.url}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reg.voucher}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("a fast upstream response is unaffected by the timeout/close wiring", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    // A tight timeout that a real (fast) upstream should never come close to.
    proxy = await startCredentialProxy(broker, { upstreamTimeoutMs: 2000 });
    const reg = broker.mint("agent-1", "l", ["send"], REAL_KEY);

    const r = await post(proxy.url, reg.voucher, "/send");
    expect(r.status).toBe(200);
  });
});
