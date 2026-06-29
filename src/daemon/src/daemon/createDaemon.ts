/**
 * createDaemon — the real daemon, end-to-end.
 *
 * A daemon holds ONLY a machine key + the server's URLs. It does NOT import a
 * server object and cannot reach the admin plane — its whole capability surface
 * is three network faces (all toward the server it was pointed at):
 *
 *   1. control plane (ws):   receive agent:start/deliver/stop, report ready/
 *      session/ack. Connects with `Authorization: Bearer <machineKey>`.
 *   2. enroll plane (http):  POST /enroll/agent-credential (Bearer machineKey) →
 *      a per-agent runner key, exchanged just before an agent calls back.
 *   3. credential proxy (http): validates agent vouchers, swaps in runner keys,
 *      stamps X-Agent-Id, and forwards to the server's data plane. ALL agent
 *      traffic (real subprocess CLI or any client) flows through here — the proxy
 *      intercepts inboxPull responses to record timeline entries.
 *
 * It is agnostic on BOTH axes:
 *   - whether the server is a real Alook server or the local `mock-server` — same
 *     wire contract either way;
 *   - whether an agent is a real runtime (Claude, Codex, …) or a test stub — the
 *     `driverFor` is INJECTED by the caller.
 *
 * That's why there is no test/mock code in here: the daemon is real, the driver is
 * a plugged-in dependency. Local tests inject a stub driver; production injects a
 * real runtime driver. Neither changes this file.
 */
import { WsControlChannel } from "../server/wsControlChannel";
import { CredentialBroker, startCredentialProxy } from "../credentials/index";
import { AgentProcessManager, AgentRouter } from "../manager/index";
import { createTimelineRecorder } from "../timeline/index";
import type { Driver, LaunchContext } from "../types";
import type { Message } from "../server/contract";

/** The minimal WebSocket the control channel needs (host injects a `ws` factory). */
export type DaemonWebSocketFactory = (url: string, headers: Record<string, string>) => unknown;

export interface CreateDaemonOptions {
  machineKey: string;
  /** Server HTTP base, e.g. http://127.0.0.1:4517 (enroll + data plane upstream). */
  serverUrl: string;
  /** Server control-plane ws base, e.g. ws://127.0.0.1:4518. */
  serverWsUrl: string;
  /** Builds the real `ws` client (injected so this module has no hard ws dep). */
  webSocketFactory: DaemonWebSocketFactory;
  /** Runtimes this daemon advertises to the server (injected — not hardcoded). */
  runtimes: string[];
  /** Per-agent runtime driver (injected — real runtime in prod, stub in tests). */
  driverFor: (agentId: string) => Driver;
  /** Default capability set granted to each agent's voucher. */
  capabilities: string[];
  /** Working directory base for agent launch contexts. */
  workingDirectoryBase?: string;
  /**
   * Absolute path to the host's agent CLI entrypoint. Real deployments point this
   * at the shim/binary the agent subprocess invokes (via a symlink in PATH).
   * Omit for test stubs that don't invoke the CLI.
   */
  agentCliPath?: string;
  tickIntervalMs?: number;
}

export interface RunningDaemon {
  /** True once the control plane is open (machine key accepted). */
  isOpen(): boolean;
  proxyUrl: string;
  stop(): Promise<void>;
}

/**
 * Start a daemon. Connects the control plane, starts the credential proxy (with
 * an inboxPull hook for timeline), enrolls agents on first contact, and wires
 * the agent manager. The full real code path is exercised — no shortcuts.
 */
export async function createDaemon(opts: CreateDaemonOptions): Promise<RunningDaemon> {
  const workdirFor = (agentId: string) => `${opts.workingDirectoryBase ?? "/tmp/alook-daemon"}/${agentId}`;

  const timeline = createTimelineRecorder({
    timelineDirFor: (agentId) => `${workdirFor(agentId)}/.context_timeline`,
    providerFor: () => opts.runtimes[0] ?? null,
  });

  const broker = new CredentialBroker({ upstreamBaseUrl: opts.serverUrl });
  const proxy = await startCredentialProxy(broker, {
    onInboxPullResponse: (agentId, messages) => timeline.appendEntryForAgent(agentId, messages),
  });

  // Per-agent enrolled runner keys (enrollment is async; stored before deliver).
  const enrolledKeys = new Map<string, string>();

  const enrollAgent = async (agentId: string): Promise<string> => {
    const existing = enrolledKeys.get(agentId);
    if (existing) return existing;
    const res = await fetch(`${opts.serverUrl}/enroll/agent-credential`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.machineKey}` },
      body: JSON.stringify({ agentId }),
    });
    const json = (await res.json()) as { runnerKey?: string; error?: string };
    if (!res.ok || !json.runnerKey) throw new Error(json.error ?? `enroll failed for ${agentId} (${res.status})`);
    enrolledKeys.set(agentId, json.runnerKey);
    return json.runnerKey;
  };

  const channel = new WsControlChannel({
    url: opts.serverWsUrl,
    headers: { Authorization: `Bearer ${opts.machineKey}` },
    webSocketFactory: opts.webSocketFactory as never,
  });

  const manager = new AgentProcessManager({
    driverFor: opts.driverFor,
    baseContextFor: (agentId: string) => {
      const runnerKey = enrolledKeys.get(agentId);
      if (!runnerKey) throw new Error(`agent ${agentId} not enrolled yet — enroll before deliver`);
      return {
        agentId,
        workingDirectory: workdirFor(agentId),
        credentialProxy: { broker, proxyUrl: proxy.url, runnerKey },
        agentCliPath: opts.agentCliPath,
        config: {},
      } as Omit<LaunchContext, "prompt" | "standingPrompt"> & { config?: LaunchContext["config"] };
    },
    tickIntervalMs: opts.tickIntervalMs ?? 2000,
    onAgentSession: (info) => void channel.reportAgentSession(info),
    timeline,
    wakePromptFooter: "Use `alook inbox pull` to read your messages, then reply with `alook message send`.",
  });
  manager.start();

  const router = new AgentRouter({
    manager,
    channel,
    runtimes: opts.runtimes,
    onBeforeAgent: async (agentId) => { await enrollAgent(agentId); },
    transformWakeText: (message: Message) =>
      `You have a new message in channel ${message.channel}.`,
  });
  channel.connect();
  await router.start();

  return {
    isOpen: () => channel.status === "open",
    proxyUrl: proxy.url,
    stop: async () => {
      channel.close();
      await proxy.close();
      await manager.stopAll();
    },
  };
}
