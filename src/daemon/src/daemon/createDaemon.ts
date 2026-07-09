/**
 * createDaemon — the real daemon, end-to-end.
 *
 * A daemon holds a machine credential (`cmk_...`) + the server's URLs. It
 * does NOT import a server object and cannot reach the admin plane — its
 * whole capability surface is three network faces (all toward the server
 * it was pointed at):
 *
 *   1. control plane (ws):   receive agent:wake/stop, report ready/
 *      session/ack. Connects with `Authorization: Bearer <machineKey>`
 *      (`cmk_`). This is the only path — no URL-token fallback exists.
 *   2. enroll plane (http):  POST /api/community/daemon/enroll-agent
 *      (Bearer `cmk_`) → per-agent runner key (`crk_`).
 *   3. credential proxy (http): validates agent vouchers, swaps in runner
 *      keys, stamps X-Agent-Id, and forwards to the server's data plane.
 *      All agent traffic flows through here.
 *
 * It is agnostic on both axes:
 *   - whether the server is a real Alook server or the local `mock-server`
 *     — same wire contract either way;
 *   - whether an agent is a real runtime (Claude, Codex, …) or a test stub
 *     — the `driverFor` is INJECTED by the caller.
 */
import { homedir } from "os";
import { WsControlChannel } from "../server/wsControlChannel.js";
import { CredentialBroker, startCredentialProxy } from "../credentials/index.js";
import { AgentProcessManager, AgentRouter } from "../manager/index.js";
import { UnknownBotError, BotEnrollFailedError, UnknownRuntimeError } from "../manager/agentRouter.js";
import { createTimelineRecorder } from "../timeline/index.js";
import { resolveAlookCliPathWithFallback } from "../discovery.js";
import { createPiSdkDriverDeps } from "../drivers/piSdkDeps.js";
import { createLogger, type Logger } from "../logger.js";
import type { Driver, LaunchContext } from "../types.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import type { UnreadNotice, HostCommand } from "../server/contract.js";
import { formatHandle } from "@alook/shared/lib/discriminator";

// Cold-start warmup backoff schedule (ms).
const WARMUP_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
const WARMUP_CEILING_MS = 30_000;

/** The minimal WebSocket the control channel needs (host injects a `ws` factory). */
export type DaemonWebSocketFactory = (url: string, headers: Record<string, string>) => unknown;

export interface CreateDaemonOptions {
  /** Long-lived credential (`cmk_...`) minted by /activate. */
  machineKey: string;
  /** Server HTTP base, e.g. http://127.0.0.1:4517 (enroll + data plane upstream). */
  serverUrl: string;
  /** Server control-plane ws base, e.g. ws://127.0.0.1:4518. */
  serverWsUrl: string;
  /** Builds the real `ws` client (injected so this module has no hard ws dep). */
  webSocketFactory: DaemonWebSocketFactory;
  /** Runtime descriptors advertised on the ready frame. Must include unhealthy runtimes too. */
  runtimeReport: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }>;
  /**
   * Per-agent runtime driver. `runtimeConfig` (server-pushed on
   * `agent:wake`) is passed so callers can dispatch on the actual runtime
   * the agent asked for; tests may omit it and hand back a stub driver.
   */
  driverFor: (agentId: string, runtimeConfig?: RuntimeConfig) => Driver;
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
  /** Called when the server rejects our machine key (fatal — no reconnect). */
  onAuthRejected?: () => void;
  /** Optional machine metadata surfaced in the ready frame. */
  hostname?: string;
  platform?: string;
  arch?: string;
  osRelease?: string;
  daemonVersion?: string;
  /**
   * Shared logger for the whole daemon process. Defaults to
   * `createLogger({ header: "@alook/daemon" })`; `.child("ws")` /
   * `.child("router")` / `.child("manager")` are passed into the respective
   * collaborators so every line from one daemon process shares one header
   * family. `daemonStart.ts` passes its own instance here so the process has
   * exactly one logger tree instead of two independent ones.
   */
  logger?: Logger;
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
  const log = opts.logger ?? createLogger({ header: "@alook/daemon" });
  const fallbackBase = (process.env.ALOOK_PROJECT_ROOT || `${homedir()}/.alook`) + "/daemon";
  const workdirFor = (agentId: string) => `${opts.workingDirectoryBase ?? fallbackBase}/${agentId}`;

  // Self-healing: resolve CLI path with fallback if primary is missing
  const resolvedCliPath = resolveAlookCliPathWithFallback(opts.agentCliPath);

  const timeline = createTimelineRecorder({
    timelineDirFor: (agentId) => `${workdirFor(agentId)}/.context_timeline`,
    providerFor: () => opts.runtimeReport[0]?.id ?? null,
  });

  const broker = new CredentialBroker({ upstreamBaseUrl: opts.serverUrl });
  const proxy = await startCredentialProxy(broker, {
    onInboxPullResponse: (agentId, messages) => timeline.appendEntryForAgent(agentId, messages),
  });

  // Per-agent enrolled runner keys (enrollment is async; stored before deliver).
  const enrolledKeys = new Map<string, string>();

  // ── Bot cache ──────────────────────────────────────────────────────────
  //
  // `botsById` holds the minimum info the daemon needs to assemble system
  // prompts + gate `agent:*` commands. Maintained by:
  //   1. Cold-start warmup on WS `ready` (HTTP fetch, retried with backoff).
  //   2. Steady-state server pushes: bot:added / bot:updated / bot:removed.
  //   3. Reconnect: warmup re-runs; server's snapshot wins.
  //
  // Note: `cmk_`-rotation-implies-re-pair is documented as an assumption;
  // runtime code doesn't handle rotation.
  const botsById = new Map<string, { name: string; discriminator: string; description?: string }>();

  async function listMyBotsHttp(): Promise<
    Array<{ id: string; name: string; discriminator: string; description?: string }>
  > {
    const res = await fetch(`${opts.serverUrl}/api/community/daemon/bots`, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.machineKey}` },
    });
    if (!res.ok) throw new Error(`listMyBots ${res.status}`);
    const json = (await res.json()) as {
      bots?: Array<{ id: string; name: string; discriminator: string; description?: string }>;
    };
    return json.bots ?? [];
  }

  async function coldStartWarmup(): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < WARMUP_CEILING_MS) {
      try {
        const bots = await listMyBotsHttp();
        // Server snapshot wins — reconcile the cache.
        botsById.clear();
        for (const b of bots) {
          botsById.set(b.id, { name: b.name, discriminator: b.discriminator, description: b.description });
        }
        log.info("cold-start bot-cache warmup succeeded", { bots: bots.length, attempt });
        return;
      } catch {
        const delay = WARMUP_BACKOFF_MS[Math.min(attempt, WARMUP_BACKOFF_MS.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
      }
    }
    // Ceiling exhausted — resolve empty. A subsequent `agent:wake` frame
    // will trigger a deferred retry via enrollAgent.
    log.warn("cold-start bot-cache warmup exhausted its ceiling", { ceilingMs: WARMUP_CEILING_MS, attempts: attempt });
  }

  /**
   * Ask the server to re-check each of this machine's bots for unread work
   * and re-wake any that have some. Recovers a message that arrived while
   * this daemon was offline: the wake-queue consumer acks (never retries) a
   * `delivered_nowhere` outcome, so without this call that wake is gone for
   * good once the daemon reconnects. The daemon drives WHEN this runs; the
   * server alone decides WHAT an `agent:wake` looks like (same
   * `dispatchOneUnreadWake` rebuild the queue consumer uses) — this call
   * carries no addressing/config, just "check now". Best-effort: logged, never
   * thrown, never blocks the rest of connect.
   */
  async function resyncPendingWakes(): Promise<void> {
    try {
      const res = await fetch(`${opts.serverUrl}/api/community/daemon/resync-wakes`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.machineKey}` },
      });
      if (!res.ok) throw new Error(`resync-wakes ${res.status}`);
      const json = (await res.json()) as { woken?: number };
      log.info("wake resync completed", { woken: json.woken ?? 0 });
    } catch (err) {
      log.warn("wake resync failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  const enrollAgent = async (agentId: string): Promise<string> => {
    const existing = enrolledKeys.get(agentId);
    if (existing) return existing;
    // Bot-scoped cache-invalidation: if this agent isn't in `botsById` we
    // don't have authoritative confirmation the server thinks it exists;
    // proceed anyway (the server-side enroll route is the source of truth
    // and will 404 if the bot is unknown/cross-owner).
    try {
      const res = await fetch(`${opts.serverUrl}/api/community/daemon/enroll-agent`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.machineKey}` },
        body: JSON.stringify({ agentId }),
      });
      const json = (await res.json()) as { runnerKey?: string; error?: string };
      if (!res.ok || !json.runnerKey) {
        if (res.status === 404) {
          throw new UnknownBotError(agentId);
        }
        throw new BotEnrollFailedError(
          agentId,
          new Error(json.error ?? `enroll failed (${res.status})`),
        );
      }
      enrolledKeys.set(agentId, json.runnerKey);
      return json.runnerKey;
    } catch (err) {
      if (err instanceof UnknownBotError || err instanceof BotEnrollFailedError) {
        log.warn("agent enroll failed", { agentId, err: err.message });
        throw err;
      }
      const wrapped = new BotEnrollFailedError(agentId, err);
      log.warn("agent enroll failed", { agentId, err: wrapped.message });
      throw wrapped;
    }
  };

  const channel = new WsControlChannel({
    url: opts.serverWsUrl,
    headers: { Authorization: `Bearer ${opts.machineKey}` },
    webSocketFactory: opts.webSocketFactory as never,
    onAuthRejected: opts.onAuthRejected,
    logger: log.child("ws"),
  });

  // Cache-side handler for bot:* frames. Runs BEFORE AgentRouter sees them,
  // via a channel wrapper (registered below).
  function handleBotFrame(cmd: HostCommand): void {
    switch (cmd.type) {
      case "bot:added":
        botsById.set(cmd.botId, { name: cmd.name, discriminator: cmd.discriminator, description: cmd.description });
        log.debug("bot:added", { botId: cmd.botId, name: cmd.name });
        break;
      case "bot:updated": {
        const prev = botsById.get(cmd.botId);
        botsById.set(cmd.botId, { name: cmd.name, discriminator: cmd.discriminator, description: cmd.description });
        // If a subprocess is running for this bot AND name/description changed,
        // stop it so the next wake trigger spawns a fresh subprocess with the
        // new system prompt. Rename is effective on next spawn, not mid-flight.
        const nameChanged = prev && prev.name !== cmd.name;
        const descChanged = prev && (prev.description ?? "") !== (cmd.description ?? "");
        log.debug("bot:updated", { botId: cmd.botId, name: cmd.name });
        if (nameChanged || descChanged) {
          void manager.stop(cmd.botId);
        }
        break;
      }
      case "bot:removed":
        botsById.delete(cmd.botId);
        enrolledKeys.delete(cmd.botId);
        log.debug("bot:removed", { botId: cmd.botId });
        void manager.stop(cmd.botId);
        break;
      default:
        break;
    }
  }

  // Router is wired below. Held in a mutable cell so `driverFor` — which
  // needs to consult live runtime-health — and the manager's session-lifecycle
  // callbacks can reach it after construction. Both closures resolve `router!`
  // lazily; router.start() runs at the bottom of createDaemon before any
  // command dispatch, so runtime code always sees a populated cell.
  let router: AgentRouter | null = null;

  const manager = new AgentProcessManager({
    // Wrap the caller's driverFor to short-circuit dispatch to a known-unhealthy
    // runtime. If the router flags the runtime as unhealthy we throw
    // UnknownRuntimeError with the healthy-only id list — the existing catch
    // in agentRouter.onCommand produces bot_runtime_missing + runtime_not_available
    // frames, matching the "runtime not installed" path.
    driverFor: (agentId, runtimeConfig) => {
      const requested = runtimeConfig?.runtime;
      if (requested && router && !router.isRuntimeHealthy(requested)) {
        throw new UnknownRuntimeError(requested, router.healthyRuntimeIds());
      }
      return opts.driverFor(agentId, runtimeConfig);
    },
    onRuntimeSpawnFailed: (runtimeId, reason) => {
      router?.markRuntimeUnhealthy(runtimeId, reason);
    },
    onRuntimeSessionEstablished: (runtimeId) => {
      router?.markRuntimeHealthy(runtimeId);
    },
    baseContextFor: (agentId: string) => {
      const runnerKey = enrolledKeys.get(agentId);
      if (!runnerKey) throw new Error(`agent ${agentId} not enrolled yet — enroll before deliver`);
      // Look up bot metadata for system-prompt assembly. Missing (unknown bot
      // that pre-dates warmup) is not fatal — the manager's default prompt
      // path handles missing name/description.
      const botMeta = botsById.get(agentId);
      return {
        agentId,
        workingDirectory: workdirFor(agentId),
        credentialProxy: { broker, proxyUrl: proxy.url, runnerKey },
        agentCliPath: resolvedCliPath ?? opts.agentCliPath,
        config: {
          ...(botMeta?.name ? { agentName: botMeta.name } : {}),
          ...(botMeta?.name && botMeta?.discriminator
            ? { agentHandle: `@${formatHandle(botMeta.name, botMeta.discriminator)}` }
            : {}),
          ...(botMeta?.description ? { description: botMeta.description } : {}),
        } as LaunchContext["config"],
      } as Omit<LaunchContext, "prompt" | "standingPrompt"> & { config?: LaunchContext["config"] };
    },
    tickIntervalMs: opts.tickIntervalMs ?? 2000,
    onAgentSession: (info) => void channel.reportAgentSession(info),
    // Only the "pi" runtime declares `Driver.createSession` today (in-process
    // SDK, no child process) — this is only ever consulted for that case.
    sdkDriverDepsFor: (ctx) => createPiSdkDriverDeps(ctx),
    timeline,
    wakePromptFooter: "Use `alook inbox pull` to read your messages, then reply with `alook message send`.",
    logger: log.child("manager"),
  });
  manager.start();

  router = new AgentRouter({
    manager,
    channel,
    runtimeReport: opts.runtimeReport,
    hostname: opts.hostname,
    platform: opts.platform,
    arch: opts.arch,
    osRelease: opts.osRelease,
    daemonVersion: opts.daemonVersion,
    logger: log.child("router"),
    // onBeforeAgent gate — reject unknown bots BEFORE enroll to keep the
    // failure code stable (`bot_unknown` vs `bot_enroll_failed`).
    onBeforeAgent: async (agentId) => {
      if (!botsById.has(agentId)) {
        // Try one deferred warmup pass — the ceiling-exhaustion case parks
        // the daemon with an empty cache; the first real frame should retry
        // the fetch once before erroring out.
        try {
          const bots = await listMyBotsHttp();
          for (const b of bots) {
            botsById.set(b.id, { name: b.name, discriminator: b.discriminator, description: b.description });
          }
        } catch {
          // Fall through — still treat as unknown below.
        }
      }
      if (!botsById.has(agentId)) {
        throw new UnknownBotError(agentId);
      }
      await enrollAgent(agentId);
    },
    formatUnreadNoticeText: (notice: UnreadNotice) =>
      `You have unread messages in channel ${notice.channel}.`,
  });

  // Register the bot-cache pre-hook. `onCommand` supports multiple listeners
  // in FIFO order — this one runs before the AgentRouter's listener (which
  // router.start() appends), so bot:* frames mutate the cache before the
  // router dispatches. No monkey-patching required.
  channel.onCommand((cmd) => {
    handleBotFrame(cmd);
  });
  // Warmup on every (re)connect — including the first open. `onOpen` fires
  // after resync completes. Wake-resync runs alongside it so a message
  // dropped while this daemon was offline gets a second chance right away.
  channel.onOpen(() => {
    void coldStartWarmup();
    void resyncPendingWakes();
  });

  channel.connect();
  await router!.start();

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
