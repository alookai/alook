/**
 * E2E: the full control plane over a REAL WebSocket.
 *
 * MockServer (data + control + admin) ─(real ws)─▶ AgentRouter ─▶ AgentProcessManager
 *   ─▶ mock agent session (pulls inbox via ServerApi, replies "hi!").
 *
 * Asserts the round-trip works end to end and that the control frames actually
 * cross a socket (not an in-process shortcut): we point WsControlChannel at the
 * WsControlServer's ws port.
 */
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { MockServer, WsControlServer, WsControlChannel } from "../../src/server/index";
import { AgentProcessManager, AgentRouter } from "../../src/manager/index";
import type { ManagedSession } from "../../src/manager/managerRuntime";
import type { ServerApi } from "../../src/server/contract";

interface Harness {
  server: MockServer;
  teardown: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const server = new MockServer();
  const api: ServerApi = server;

  // Bind to an OS-assigned ephemeral port (port 0) to avoid collisions when
  // tests share a process, then read it back for the client URL.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const addr = wss.address();
  const wsPort = typeof addr === "object" && addr ? addr.port : 0;

  const wsServer = new WsControlServer({
    server,
    port: wsPort,
    webSocketServerFactory: () => wss, // reuse the already-listening server
  });
  wsServer.start();
  const channel = new WsControlChannel({
    url: `ws://127.0.0.1:${wsPort}`,
    webSocketFactory: (url, headers) => new WebSocket(url, { headers }) as never,
  });

  const manager = new AgentProcessManager({
    driverFor: () => ({ lifecycle: { kind: "persistent" } }) as never,
    baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp/cp-e2e", standingPrompt: "", config: {} }),
    sessionFactory: ({ agentId }) => makeMockAgentSession(agentId, api),
    tickIntervalMs: 500,
    onAgentSession: (info) => void channel.reportAgentSession(info),
  });
  manager.start();
  const router = new AgentRouter({ manager, channel, runtimeReport: [{ id: "mock" }] });
  channel.connect();
  await router.start();
  await waitFor(() => channel.status === "open", 3000);

  return {
    server,
    teardown: async () => {
      channel.close();
      await wsServer.close();
      await manager.stopAll();
    },
  };
}

/** Mock agent: on wake, pull inbox, ack, reply "hi!" to each message. */
function makeMockAgentSession(agentId: string, api: ServerApi): ManagedSession {
  const sessionId = `mock-${agentId}`;
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const emit = (ev: string, arg?: unknown) => (handlers[ev] ?? []).forEach((h) => h(arg));
  // Pull + ack the inbox so the agent is aligned to each channel's latest.
  const pullAndAlign = async (): Promise<string[]> => {
    const { messages } = await api.inboxPull({ agentId, max: 50 });
    const latest = new Map<string, number>();
    for (const m of messages) {
      const n = Number(m.seq.replace("#", "")) || 0;
      if (n > (latest.get(m.channel) ?? 0)) latest.set(m.channel, n);
    }
    if (latest.size) await api.ack({ agentId, cursors: [...latest].map(([channel, seq]) => ({ channel, seq })) });
    return [...latest.keys()];
  };
  const wake = async () => {
    emit("runtime_event", { kind: "session_init", sessionId });
    const channels = await pullAndAlign();
    // Reply per channel. With strict channel alignment, a peer's reply landing
    // first makes THIS agent unaligned, so a send may be blocked — re-pull to
    // realign and retry (a real agent does the same: pull, then resend).
    for (const channel of channels) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await api.send({ agentId, channel, content: { text: "hi!" } });
        if (res.state === "sent") break;
        await pullAndAlign(); // realign, then retry
      }
    }
    emit("runtime_event", { kind: "turn_end", sessionId });
  };
  return {
    on: (ev, cb) => ((handlers[ev] ??= []).push(cb)),
    get currentSessionId() {
      return sessionId;
    },
    async start() {
      void wake();
    },
    send() {
      void wake();
      return { ok: true };
    },
    async stop() {
      emit("exit", { reason: "requested" });
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await delay(20);
  }
}

describe("control plane over real ws (e2e)", () => {
  let teardown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  it("a posted message drives agent:start over ws and the agent replies", async () => {
    const h = await setup();
    teardown = h.teardown;
    const { server } = h;

    const { user } = await server.createUser({ name: "me" });
    const { agent } = await server.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });
    const { server: srv } = await server.createServer({ name: "demo" });
    await server.addAgentToServer({ agentId: agent.id, server: srv.id });
    const { channel: ch } = await server.createChannel({ server: srv.id, name: "general" });
    const ref = `/${srv.id}/${ch.id}`;

    await server.postMessage({ channel: ref, sender: "@gustavo", text: "cindy, say hi" });

    // Wait until the agent has replied (its message lands in the channel).
    await waitFor(async () => {
      const page = await server.read({ agentId: agent.id, channel: ref, limit: 10 });
      return page.items.some((m) => m.sender.includes("cindy") && m.content.text === "hi!");
    }, 5000);

    const page = await server.read({ agentId: agent.id, channel: ref, limit: 10 });
    const replies = page.items.filter((m) => m.content.text === "hi!");
    expect(replies.length).toBe(1);
  });

  it("multiple agents each reply (3/3)", async () => {
    const h = await setup();
    teardown = h.teardown;
    const { server } = h;

    const { user } = await server.createUser({ name: "me" });
    const { server: srv } = await server.createServer({ name: "demo" });
    const { channel: ch } = await server.createChannel({ server: srv.id, name: "general" });
    const ref = `/${srv.id}/${ch.id}`;
    const names = ["cindy", "devon", "echo"];
    const ids: string[] = [];
    for (const name of names) {
      const { agent } = await server.createAgent({ userId: user.id, name, runtime: "mock" });
      await server.addAgentToServer({ agentId: agent.id, server: srv.id });
      ids.push(agent.id);
    }

    await server.postMessage({ channel: ref, sender: "@gustavo", text: "hello team" });

    await waitFor(async () => {
      const page = await server.read({ agentId: ids[0], channel: ref, limit: 20 });
      return page.items.filter((m) => m.content.text === "hi!").length >= 3;
    }, 6000);

    const page = await server.read({ agentId: ids[0], channel: ref, limit: 20 });
    expect(page.items.filter((m) => m.content.text === "hi!").length).toBe(3);
  });
});
