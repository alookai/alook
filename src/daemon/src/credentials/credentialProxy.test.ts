import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import * as fs from "fs";
import { CredentialBroker, startCredentialProxy, type RunningProxy } from "./credentialProxy";

const REAL_KEY = "sk_real_SUPER_SECRET";

interface SeenRequest {
  authorization?: string;
  agentId?: string;
  client?: string;
  capabilities?: string;
  path?: string;
}

/** A throwaway upstream that records what headers + path the proxy forwards. */
async function startUpstream(): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      authorization: req.headers["authorization"] as string | undefined,
      agentId: req.headers["x-agent-id"] as string | undefined,
      client: req.headers["x-client"] as string | undefined,
      capabilities: req.headers["x-agent-active-capabilities"] as string | undefined,
      path: req.url,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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

async function post(url: string, voucher: string, path: string) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${voucher}`, "content-type": "application/json" },
    body: JSON.stringify({ hi: 1 }),
  });
  return { status: res.status, body: await res.text() };
}

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

    const r = await post(proxy.url, reg.voucher, "/send");
    expect(r.status).toBe(403);
    expect(upstream.seen.length).toBe(0);
  });

  it("rewrites /api/* to /api/community/agent/* (design §9)", async () => {
    const upstream = await startUpstream();
    upstreamClose = upstream.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: upstream.url });
    proxy = await startCredentialProxy(broker);
    const reg = broker.mint("agent-1", "l", ["send", "read"], REAL_KEY);

    await post(proxy.url, reg.voucher, "/api/send");
    expect(upstream.seen.at(-1)!.path).toBe("/api/community/agent/send");

    await post(proxy.url, reg.voucher, "/api/inboxPull?max=10");
    expect(upstream.seen.at(-1)!.path).toBe("/api/community/agent/inboxPull?max=10");

    await post(proxy.url, reg.voucher, "/api");
    expect(upstream.seen.at(-1)!.path).toBe("/api/community/agent");
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

    const r = await post(proxy.url, reg.voucher, "/api/send");
    expect(r.status).toBe(200);
    expect(sightings).toEqual([{ agentId: "agent-1", method: "POST", pathname: "/api/send" }]);
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

    // Capability denied → 403 (still not fired).
    const scoped = broker.mint("agent-1", "l", ["read"], REAL_KEY);
    const denied = await post(proxy.url, scoped.voucher, "/api/send");
    expect(denied.status).toBe(403);

    expect(sightings).toEqual([]);
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

    const r = await post(proxy.url, reg.voucher, "/api/inboxPull");
    expect(r.status).toBe(200);
    // `startUpstream()` always responds `{ ok: true }` — no `messages` field —
    // so the callback should NOT fire for a response that isn't shaped like
    // an inboxPull payload, but the response itself must still be forwarded.
    expect(seen).toEqual([]);
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
