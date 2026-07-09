/**
 * Agent process manager — thin side-effect executor.
 *
 * This is the impure half: it owns the mutable `ManagerState`, drives the pure
 * `reduceManager` policy with real events, and applies the emitted effects
 * against real runtime sessions (spawn / send / stop) plus a tick timer for
 * stall detection. It is intentionally thin — all decisions live in the policy;
 * this layer only does I/O.
 *
 * A host wires it up with a `SessionFactory` (how to build a runtime session for
 * an agent) and feeds it inbound messages via `deliver()`.
 */
import {
  reduceManager,
  createInitialManagerState,
  type ManagerState,
  type ManagerEvent,
  type ManagerEffect,
  type AgentRuntimeCaps,
  type AgentMsg,
} from "./managerPolicy.js";
import type { Driver, LaunchContext, SdkDriverDeps } from "../types.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import { createChildProcessRuntimeSession, type ChildProcessRuntimeSession } from "../runtime/runtimeSession.js";
import { SdkManagedSession } from "../runtime/sdkManagedSession.js";
import { createLogger, type Logger } from "../logger.js";

/** Minimal shape the executor needs from a runtime session. */
export interface ManagedSession {
  on(event: string, cb: (...args: unknown[]) => void): void;
  start(input: { text: string; sessionId?: string }): Promise<unknown>;
  send(input: { text: string; mode: "busy" | "idle" }): unknown;
  stop(opts?: { reason?: string; forceAfterMs?: number }): Promise<void> | void;
  readonly currentSessionId: string | null;
}

/**
 * How the host builds a session for an agent launch. Given the agent id, the
 * driver, and the launch context (prompt + resume id filled in), return a
 * session the executor will drive.
 */
export type SessionFactory = (args: {
  agentId: string;
  driver: Driver;
  ctx: LaunchContext;
}) => ManagedSession;

export interface ManagerRuntimeOpts {
  /**
   * Resolve a driver for an agent. The optional `runtimeConfig` is supplied
   * whenever the manager knows it (i.e. after `register` with the server-pushed
   * config) so callers can pick the right runtime; tests may omit it.
   */
  driverFor: (agentId: string, runtimeConfig?: RuntimeConfig) => Driver;
  baseContextFor: (agentId: string) => Omit<LaunchContext, "prompt" | "config" | "standingPrompt"> & {
    standingPrompt?: string;
    config?: LaunchContext["config"];
  };
  sessionFactory?: SessionFactory;
  /**
   * Zero-trust credential handoff for real (child-process) spawns. Required when
   * NOT using a `sessionFactory` — `prepareCliTransport` refuses to launch a CLI
   * runtime without it (no plaintext fallback). Threaded into each LaunchContext.
   */
  credentialProxy?: LaunchContext["credentialProxy"];
  /**
   * Builds the `SdkDriverDeps` for an in-process SDK driver's `createSession`
   * (see `types.ts`). Required when NOT using a `sessionFactory` AND a
   * resolved driver declares `createSession` (Pi today) — mirrors the
   * `credentialProxy` requirement for child-process drivers. Called once per
   * spawn with the same base `ctx` a `ChildProcessRuntimeSession` would get.
   */
  sdkDriverDepsFor?: (ctx: LaunchContext) => SdkDriverDeps;
  staleThresholdMs?: number;
  /** Idle hibernation timeout (ms): stop a persistent process idle this long. */
  idleTimeoutMs?: number;
  tickIntervalMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Notified when an agent's runtime session id is first learned (from a
   * `session_init` event). The router relays this to the server as
   * `reportAgentSession` so the server can correlate + resume.
   */
  onAgentSession?: (info: { agentId: string; sessionId: string; launchId: string }) => void;
  /**
   * Optional context-timeline recorder. When provided, the manager logs each
   * spawn as a "running" row, fills in the session id on session_init, and closes
   * the row on turn_end / exit — a pure DAILY LOG, no steering. It also supplies
   * the resume session id for an agent's next launch (latest finished session in
   * that agent's own timeline). Omitted ⇒ no logging, in-memory resume only.
   */
  timeline?: TimelineRecorder;
  /**
   * Appended once to the coalesced wake prompt (after dedup). Use for a
   * one-shot instruction like "Use `alook inbox pull` to read your messages."
   */
  wakePromptFooter?: string;
  /**
   * Notified when a spawn fails BEFORE the runtime emits its handshake
   * `runtime_event` (pre-establishment error). Typically wired to
   * `AgentRouter.markRuntimeUnhealthy` so /community reflects the broken
   * runtime; see plans/community-machine-presence-fix.md.
   *
   * `reason` is a short code like `"ENOENT"` or `"pre_handshake_exit"`.
   */
  onRuntimeSpawnFailed?: (runtimeId: string, reason: string) => void;
  /**
   * Notified once per session when it emits its first post-handshake
   * `runtime_event`. Typically wired to `AgentRouter.markRuntimeHealthy` so
   * a runtime that was flagged unhealthy self-heals after the user fixes
   * their install (or after a genuine transient failure).
   */
  onRuntimeSessionEstablished?: (runtimeId: string) => void;
  /** Defaults to `createLogger({ header: "@alook/daemon:manager" })`. */
  logger?: Logger;
}

/**
 * Lifecycle sink the manager calls to record turns + look up resume. Kept as an
 * injected interface so managerRuntime stays fs-free and unit-testable; the
 * daemon backs it with the `src/timeline` module over the agent's workdir.
 */
export interface TimelineRecorder {
  /**
   * Record the runtime session id (from session_init). The recorder bakes it into
   * the entry opened by the agent's next inbox pull (which happens after
   * session_init), so the row carries the right session id.
   */
  setSession(agentId: string, sessionId: string): void;
  /**
   * Append a piece of the agent's response (a runtime `text` event) to the
   * agent's latest entry's `agent_responses` — the "what I said this turn" data
   * that makes the timeline usable as memory. The entry itself is opened on the
   * DATA plane (inbox pull); the manager only accumulates onto the latest row.
   */
  appendResponseToLatest(agentId: string, text: string): void;
  /** Latest session id for this agent (resume target), or null. */
  resumeSessionId(agentId: string, provider: string | null): string | null;
}

export class AgentProcessManager {
  private state: ManagerState;
  private readonly sessions = new Map<string, ManagedSession>();
  /** agentId → server-pushed RuntimeConfig (from agent:wake). */
  private readonly runtimeConfigs = new Map<string, RuntimeConfig>();
  /** agentId → resume sessionId pushed by the server (from agent:wake). */
  private readonly resumeSessions = new Map<string, string>();
  /** agentId → launchId from the latest agent:wake (for session correlation). */
  private readonly launchIds = new Map<string, string>();
  /** agentId → live runtime sessionId (learned from session_init), for resync. */
  private readonly liveSessions = new Map<string, string>();
  /**
   * agentId → the current spawn's per-session end-tracking flags, shared
   * between `doSpawn`'s closure (turn_end / exit) and `applyEffect` (stop /
   * terminate_stalled) — see `logSessionEnded`'s `suppressExitLog` handling.
   */
  private readonly activeSpawnState = new Map<
    string,
    { hasEstablished: boolean; hasReportedSpawnFailure: boolean; suppressExitLog: boolean }
  >();
  private readonly opts: Required<
    Omit<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "sdkDriverDepsFor"
      | "onAgentSession"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
      | "logger"
    >
  > &
    Pick<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "sdkDriverDepsFor"
      | "onAgentSession"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
      | "logger"
    >;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(opts: ManagerRuntimeOpts) {
    this.opts = {
      tickIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      idleTimeoutMs: 300_000,
      ...opts,
    };
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? createLogger({ header: "@alook/daemon:manager" });
    this.state = createInitialManagerState(this.opts.staleThresholdMs, this.opts.idleTimeoutMs);
  }

  /**
   * Register an agent (idempotent) so it can receive messages. `launch` carries
   * the server-pushed RuntimeConfig (and optional resume sessionId) from
   * `agent:wake`; it's remembered and merged into the LaunchContext at spawn.
   */
  register(agentId: string, launch?: { runtimeConfig?: RuntimeConfig; sessionId?: string; launchId?: string }): void {
    if (launch?.runtimeConfig) this.runtimeConfigs.set(agentId, launch.runtimeConfig);
    if (launch?.sessionId) this.resumeSessions.set(agentId, launch.sessionId);
    if (launch?.launchId) this.launchIds.set(agentId, launch.launchId);
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    const caps: AgentRuntimeCaps = {
      lifecycleKind: driver.lifecycle.kind,
      supportsStdinNotification: driver.supportsStdinNotification,
      busyDeliveryMode: driver.busyDeliveryMode,
    };
    this.dispatch({ type: "register", agentId, caps });
  }

  /** Inbound message for an agent → drives spawn/steer/queue per policy. */
  deliver(agentId: string, message: AgentMsg): void {
    this.dispatch({ type: "wake", agentId, message, nowMs: this.now() });
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.dispatch({ type: "tick", nowMs: this.now() }), this.opts.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  /** Stop a single agent's session (if running). */
  async stop(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    await Promise.resolve(session.stop({ reason: "requested", forceAfterMs: 5_000 }));
    this.sessions.delete(agentId);
  }

  async stopAll(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    await Promise.all([...this.sessions.values()].map((s) => Promise.resolve(s.stop({ reason: "shutdown" }))));
    this.sessions.clear();
  }

  /** For inspection/testing. */
  snapshot(): ManagerState {
    return this.state;
  }

  /**
   * Live agent sessions (agentId + sessionId + launchId) for control-plane
   * resync after a reconnect. Only agents whose runtime has reported a session.
   */
  liveSessionReports(): Array<{ agentId: string; sessionId: string; launchId: string }> {
    return [...this.liveSessions.entries()].map(([agentId, sessionId]) => ({
      agentId,
      sessionId,
      launchId: this.launchIds.get(agentId) ?? "",
    }));
  }

  /* --------------------------------------------------------------- */
  /* Core dispatch: reduce → apply effects                            */
  /* --------------------------------------------------------------- */

  private dispatch(event: ManagerEvent): void {
    const { state, effects } = reduceManager(this.state, event);
    this.state = state;
    for (const effect of effects) this.applyEffect(effect);
  }

  private withFooter(text: string): string {
    return this.opts.wakePromptFooter ? `${text}\n\n${this.opts.wakePromptFooter}` : text;
  }

  private applyEffect(effect: ManagerEffect): void {
    switch (effect.type) {
      case "spawn":
        this.doSpawn(effect.agentId, this.withFooter(effect.prompt), effect.resumeSessionId);
        break;
      case "send": {
        const session = this.sessions.get(effect.agentId);
        session?.send({ text: this.withFooter(effect.text), mode: effect.mode });
        this.log.info("steering message sent to running agent", { agentId: effect.agentId, mode: effect.mode });
        break;
      }
      case "stop":
      case "terminate_stalled": {
        const session = this.sessions.get(effect.agentId);
        void Promise.resolve(session?.stop({ reason: effect.type, forceAfterMs: 5_000 }));
        // The stop we just issued will make the underlying process emit its
        // own `exit` shortly after — suppress that follow-up log so a single
        // termination doesn't produce two contradictory "session ended" lines.
        const spawnState = this.activeSpawnState.get(effect.agentId);
        if (spawnState) spawnState.suppressExitLog = true;
        this.logSessionEnded(effect.agentId, effect.type === "stop" ? "stopped" : "terminate_stalled");
        break;
      }
      case "gated_hold":
        // Pure observability — no behavioral effect. Emitted whenever a
        // gated agent has a non-empty inbox but nothing was actually sent.
        this.log.info("gated busy message held", {
          agentId: effect.agentId,
          reason: effect.reason,
          blockedReason: effect.blockedReason,
          recentEvents: effect.recentEvents,
        });
        break;
    }
  }

  private logSessionEnded(agentId: string, reason: "turn_end" | "stopped" | "terminate_stalled" | "exit"): void {
    this.log.info("agent session ended", { agentId, sessionId: this.liveSessions.get(agentId) ?? "", reason });
  }

  private doSpawn(agentId: string, prompt: string, resumeSessionId: string | null): void {
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    this.log.info("spawning agent", { agentId, runtime: driver.id });
    const base = this.opts.baseContextFor(agentId);
    // The server-pushed RuntimeConfig (from agent:wake) takes precedence over
    // any baseContextFor default; the resume sessionId likewise prefers the
    // manager's runtime-tracked id, then the server-pushed one, then the base.
    const runtimeConfig = this.runtimeConfigs.get(agentId) ?? base.config?.runtimeConfig;
    const provider = runtimeConfig?.runtime ?? null;
    // Resume precedence: an explicit effect-supplied id → the manager's in-memory
    // tracked id → the server-pushed id → the durable timeline (latest finished
    // session for this agent, survives daemon restarts) → the base context.
    const sessionId =
      resumeSessionId ??
      this.resumeSessions.get(agentId) ??
      this.opts.timeline?.resumeSessionId(agentId, provider) ??
      base.config?.sessionId;
    const description = runtimeConfig?.instruction ?? base.config?.description ?? runtimeConfig?.agentName;
    const agentName = runtimeConfig?.agentName ?? base.config?.agentName;
    const agentHandle = runtimeConfig?.agentHandle ?? base.config?.agentHandle;
    const config: LaunchContext["config"] = { ...(base.config ?? {}), runtimeConfig, sessionId, description, agentName, agentHandle };
    // The driver owns system-prompt assembly — it knows its runtime's format,
    // notification style, and CLI contract. The daemon just calls it.
    const standingPrompt = base.standingPrompt || driver.buildSystemPrompt?.(config, agentId) || "";
    const ctx: LaunchContext = {
      ...base,
      prompt,
      standingPrompt,
      credentialProxy: base.credentialProxy ?? this.opts.credentialProxy,
      config,
    };

    if (!this.opts.sessionFactory && driver.createSession && !this.opts.sdkDriverDepsFor) {
      throw new Error(
        `AgentProcessManager: real spawn of "${agentId}" on in-process SDK runtime "${driver.id}" needs ` +
        "sdkDriverDepsFor — set ManagerRuntimeOpts.sdkDriverDepsFor, or pass a sessionFactory for tests.",
      );
    }
    if (!this.opts.sessionFactory && !driver.createSession && !ctx.credentialProxy) {
      throw new Error(
        `AgentProcessManager: real spawn of "${agentId}" needs a credentialProxy — ` +
        "set ManagerRuntimeOpts.credentialProxy (or baseContextFor's), or pass a sessionFactory for tests.",
      );
    }

    const session: ManagedSession = this.opts.sessionFactory
      ? this.opts.sessionFactory({ agentId, driver, ctx })
      : driver.createSession
        ? new SdkManagedSession(
          driver as Driver & { createSession: NonNullable<Driver["createSession"]> },
          ctx,
          this.opts.sdkDriverDepsFor!(ctx),
        )
        : (createChildProcessRuntimeSession(driver, ctx) as ChildProcessRuntimeSession);

    this.sessions.set(agentId, session);

    // Per-session flags.
    //   - hasEstablished: has this session ever emitted its handshake
    //     `runtime_event`? Once true, `error`/`exit` are session-level and
    //     don't invalidate the runtime.
    //   - hasReportedSpawnFailure: guards against multiple pre-establishment
    //     paths reporting the SAME failure (child_process emits both `error`
    //     and `exit` on ENOENT, plus `session.start().catch`). Only the FIRST
    //     path to see the failure gets to name the reason — subsequent paths
    //     no-op instead of clobbering a specific `ENOENT` with generic
    //     `pre_handshake_exit`.
    //   - suppressExitLog: set once this session's end has already been
    //     logged via a more specific reason (`turn_end` for a `per_turn`
    //     runtime that's about to exit on its own, or `stopped`/
    //     `terminate_stalled` from `applyEffect`) so the process's eventual
    //     `exit` event doesn't ALSO log a redundant/contradictory
    //     "session ended" line for the same termination.
    const state = { hasEstablished: false, hasReportedSpawnFailure: false, suppressExitLog: false };
    this.activeSpawnState.set(agentId, state);
    const reportSpawnFailure = (reason: string) => {
      if (state.hasEstablished || state.hasReportedSpawnFailure) return;
      state.hasReportedSpawnFailure = true;
      this.log.warn("spawn failed", { agentId, runtime: driver.id, reason });
      this.opts.onRuntimeSpawnFailed?.(driver.id, reason);
    };

    // Timeline entries are opened on the DATA plane (the agent's inbox pull),
    // not here — the manager only annotates the agent's latest row.
    session.on("runtime_event", (e: unknown) => {
      if (!state.hasEstablished) {
        state.hasEstablished = true;
      }
      // Fire on every runtime_event — the router's idempotence check on
      // `markRuntimeHealthy` (status already healthy + no lastError) collapses
      // this to nothing on the wire. Firing unconditionally avoids the trap
      // where session A established, session B failed and flipped the runtime
      // unhealthy, and A's ongoing runtime_events never heal it back.
      this.opts.onRuntimeSessionEstablished?.(driver.id);
      // A `per_turn` runtime handles exactly one turn per spawn and exits on
      // its own right after (see managerPolicy's onTurnEnd) — that upcoming
      // `exit` is expected, not a new termination, so don't double-log it.
      if ((e as { kind?: string })?.kind === "turn_end" && driver.lifecycle.kind === "per_turn") {
        state.suppressExitLog = true;
      }
      this.onRuntimeEvent(agentId, e, driver.id);
    });
    // Child-process `error` (ENOENT etc.) — Node EE emits this before or in
    // parallel with `exit`. Without this subscriber the raw `error` would
    // become an unhandled EE emit.
    session.on("error", (...args: unknown[]) => {
      const err = args[0] as (NodeJS.ErrnoException & { code?: string }) | undefined;
      const code = err?.code ?? "spawn_error";
      reportSpawnFailure(String(code));
    });
    session.on("exit", () => {
      // A session that exits without ever emitting `runtime_event` is
      // treated as a pre-handshake failure too — covers runtimes whose
      // wrapper binary exits non-zero without a Node-level `error` event.
      // Guarded by `hasReportedSpawnFailure` so an ENOENT (already reported
      // via `error`) doesn't get overwritten with generic `pre_handshake_exit`.
      reportSpawnFailure("pre_handshake_exit");
      // Only an ESTABLISHED session "ended" — a pre-handshake exit is
      // already covered by the spawn-failed warning above. And only if this
      // termination wasn't already logged under a more specific reason (see
      // `suppressExitLog` above).
      if (state.hasEstablished && !state.suppressExitLog) this.logSessionEnded(agentId, "exit");
      this.sessions.delete(agentId);
      this.liveSessions.delete(agentId);
      if (this.activeSpawnState.get(agentId) === state) this.activeSpawnState.delete(agentId);
      this.dispatch({ type: "exit", agentId });
    });

    void Promise.resolve(session.start({ text: prompt, sessionId: ctx.config.sessionId }))
      .then(() => {
        // A concurrent stop()/terminate_stalled can race this in-flight
        // start() and finish first — its `exit` handler above already
        // deleted this session from `this.sessions` and dispatched
        // `{type: "exit"}`. If that happened, don't ALSO dispatch `spawned`:
        // that would revive the FSM into "running" for a session nobody
        // tracks anymore, wedging the agent (its inbox already drained into
        // this now-dead spawn) until the daemon restarts.
        if (this.sessions.get(agentId) !== session) return;
        this.dispatch({ type: "spawned", agentId, nowMs: this.now() });
      })
      .catch((err: unknown) => {
        // Synchronous throws inside driver.spawn() (e.g. child_process.spawn
        // throwing ENOENT before returning a subprocess) reach us here.
        // Same guard: whichever path saw the failure first names the reason.
        const code =
          (err as { code?: string } | undefined)?.code ??
          "spawn_threw";
        reportSpawnFailure(String(code));
        if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
        this.dispatch({ type: "exit", agentId });
      });
  }

  private onRuntimeEvent(agentId: string, e: unknown, runtimeId: string): void {
    const ev = e as { kind?: string; sessionId?: string; text?: string };
    if (!ev?.kind) return;
    if (ev.kind === "session_init" && ev.sessionId) {
      this.dispatch({ type: "session", agentId, sessionId: ev.sessionId });
      this.liveSessions.set(agentId, ev.sessionId);
      this.opts.timeline?.setSession(agentId, ev.sessionId);
      this.opts.onAgentSession?.({
        agentId,
        sessionId: ev.sessionId,
        launchId: this.launchIds.get(agentId) ?? "",
      });
      this.log.info("agent session established", { agentId, sessionId: ev.sessionId, runtime: runtimeId });
    }
    // Accumulate the agent's text output onto its latest timeline entry, so the
    // log records "what the agent said" — the basis for using it as memory.
    if (ev.kind === "text" && typeof ev.text === "string" && ev.text.length > 0) {
      this.opts.timeline?.appendResponseToLatest(agentId, ev.text);
    }
    // Any event is progress for stall detection.
    this.dispatch({ type: "progress", agentId, nowMs: this.now() });
    // Forward every parsed event's kind for gated-steering phase tracking
    // (tool/compaction/review boundaries). No-ops in the reducer for kinds
    // it doesn't care about, aside from the diagnostics ring buffer.
    this.dispatch({ type: "runtime_signal", agentId, kind: ev.kind, nowMs: this.now() });
    if (ev.kind === "turn_end") {
      this.logSessionEnded(agentId, "turn_end");
      this.dispatch({ type: "turn_end", agentId, nowMs: this.now() });
    }
  }
}
