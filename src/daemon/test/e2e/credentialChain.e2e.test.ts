/**
 * E2E: the agent data-plane credential chain.
 *
 *   proxyServerApi client ──Bearer vch_──▶ credential proxy ──swap key + stamp
 *     X-Agent-Id (from voucher)──▶ bridge /api/* ──▶ MockServer
 *
 * Proves the agent reaches the data plane ONLY by holding a voucher, and that the
 * proxy turns that voucher into a trusted X-Agent-Id — i.e. the real credential +
 * verification path is exercised, not bypassed.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import { MockServer } from "../../src/server/index";
import { CredentialBroker, startCredentialProxy, type RunningProxy } from "../../src/credentials/index";
import { createProxyServerApi } from "../../src/cli/proxyServerApi";

/** A tiny bridge that records the X-Agent-Id the proxy stamps and forwards to MockServer. */
function startBridge(server: MockServer): Promise<{ url: string; seenAgentIds: string[]; close: () => Promise<void> }> {
  const seenAgentIds: string[] = [];
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const m = /^\/api\/(\w+)$/.exec(req.url ?? "");
      if (!m) {
        res.writeHead(404).end();
        return;
      }
      const method = m[1];
      const agentId = req.headers["x-agent-id"] as string | undefined;
      if (agentId) seenAgentIds.push(agentId);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      // The bridge injects the TRUSTED agentId from the proxy header (overriding
      // anything in the body — here the body has none).
      const withId = { ...body, agentId: agentId ?? body.agentId };
      try {
        const fn = (server as unknown as Record<string, (a: unknown) => Promise<unknown>>)[method];
        const result = await fn.call(server, withId);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ?? {}));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
    })();
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seenAgentIds,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}

describe("agent data-plane credential chain (e2e)", () => {
  let proxy: RunningProxy | undefined;
  let bridgeClose: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await proxy?.close();
    await bridgeClose?.();
    proxy = undefined;
    bridgeClose = undefined;
  });

  it("agent reaches the data plane via voucher; proxy stamps a trusted X-Agent-Id", async () => {
    const server = new MockServer();
    const { user } = await server.createUser({ name: "u" });
    const { agent } = await server.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });
    const { server: srv } = await server.createServer({ name: "demo" });
    await server.addAgentToServer({ agentId: agent.id, server: srv.id });
    const { channel: ch } = await server.createChannel({ server: srv.id, name: "general" });
    const ref = `/${srv.id}/${ch.id}`;

    const bridge = await startBridge(server);
    bridgeClose = bridge.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: bridge.url });
    proxy = await startCredentialProxy(broker);

    // Host mints a voucher for this agent launch; the agent gets ONLY the voucher.
    const reg = broker.mint(agent.id, "launch-1", ["send", "read"], "sk_agent_stub");
    const apiClient = createProxyServerApi({ proxyUrl: proxy.url, voucher: reg.voucher });

    // Agent reads via the voucher — note: NO agentId is sent on the wire.
    const page = await apiClient.read({ agentId: "ignored-by-wire", channel: ref, limit: 10 });
    expect(Array.isArray(page.items)).toBe(true);

    // The proxy stamped the agent's real id (from the voucher), not "ignored-by-wire".
    expect(bridge.seenAgentIds).toContain(agent.id);
    expect(bridge.seenAgentIds).not.toContain("ignored-by-wire");
  });

  it("an invalid voucher is rejected at the proxy (never reaches the bridge)", async () => {
    const server = new MockServer();
    const bridge = await startBridge(server);
    bridgeClose = bridge.close;
    const broker = new CredentialBroker({ upstreamBaseUrl: bridge.url });
    proxy = await startCredentialProxy(broker);

    const apiClient = createProxyServerApi({ proxyUrl: proxy.url, voucher: "vch_forged" });
    await expect(apiClient.read({ agentId: "x", channel: "/demo/general", limit: 1 })).rejects.toThrow();
    expect(bridge.seenAgentIds.length).toBe(0);
  });
});
