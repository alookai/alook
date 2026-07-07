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
}

/** A throwaway upstream that records what headers the proxy forwards. */
async function startUpstream(): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      authorization: req.headers["authorization"] as string | undefined,
      agentId: req.headers["x-agent-id"] as string | undefined,
      client: req.headers["x-client"] as string | undefined,
      capabilities: req.headers["x-agent-active-capabilities"] as string | undefined,
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
    const reg = broker.mint("a", "l", ["send", "read"], REAL_KEY); // no "tasks"

    const r = await post(proxy.url, reg.voucher, "/tasks/claim");
    expect(r.status).toBe(403);
    expect(upstream.seen.length).toBe(0);
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
});
