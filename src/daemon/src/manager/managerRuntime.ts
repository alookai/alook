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
import type { Driver, LaunchContext } from "../types.js";
import type { RuntimeConfig } from "../runtimeConfig.js";
import { createChildProcessRuntimeSession, type ChildProcessRuntimeSession } from "../runtime/runtimeSession.js";

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
  /** agentId → server-pushed RuntimeConfig (from agent:start). */
  private readonly runtimeConfigs = new Map<string, RuntimeConfig>();
  /** agentId → resume sessionId pushed by the server (from agent:start). */
  private readonly resumeSessions = new Map<string, string>();
  /** agentId → launchId from the latest agent:start (for session correlation). */
  private readonly launchIds = new Map<string, string>();
  /** agentId → live runtime sessionId (learned from session_init), for resync. */
  private readonly liveSessions = new Map<string, string>();
  private readonly opts: Required<
    Omit<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "onAgentSession"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
    >
  > &
    Pick<
      ManagerRuntimeOpts,
      | "sessionFactory"
      | "now"
      | "credentialProxy"
      | "onAgentSession"
      | "timeline"
      | "wakePromptFooter"
      | "onRuntimeSpawnFailed"
      | "onRuntimeSessionEstablished"
    >;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(opts: ManagerRuntimeOpts) {
    this.opts = {
      tickIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      idleTimeoutMs: 300_000,
      ...opts,
    };
    this.now = opts.now ?? (() => Date.now());
    this.state = createInitialManagerState(this.opts.staleThresholdMs, this.opts.idleTimeoutMs);
  }

  /**
   * Register an agent (idempotent) so it can receive messages. `launch` carries
   * the server-pushed RuntimeConfig (and optional resume sessionId) from
   * `agent:start`; it's remembered and merged into the LaunchContext at spawn.
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
        break;
      }
      case "stop":
      case "terminate_stalled": {
        const session = this.sessions.get(effect.agentId);
        void Promise.resolve(session?.stop({ reason: effect.type, forceAfterMs: 5_000 }));
        break;
      }
    }
  }

  private doSpawn(agentId: string, prompt: string, resumeSessionId: string | null): void {
    const driver = this.opts.driverFor(agentId, this.runtimeConfigs.get(agentId));
    const base = this.opts.baseContextFor(agentId);
    // The server-pushed RuntimeConfig (from agent:start) takes precedence over
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

    if (!this.opts.sessionFactory && !ctx.credentialProxy) {
      throw new Error(
        `AgentProcessManager: real spawn of "${agentId}" needs a credentialProxy — ` +
          "set ManagerRuntimeOpts.credentialProxy (or baseContextFor's), or pass a sessionFactory for tests.",
      );
    }

    const session: ManagedSession = this.opts.sessionFactory
      ? this.opts.sessionFactory({ agentId, driver, ctx })
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
    const state = { hasEstablished: false, hasReportedSpawnFailure: false };
    const reportSpawnFailure = (reason: string) => {
      if (state.hasEstablished || state.hasReportedSpawnFailure) return;
      state.hasReportedSpawnFailure = true;
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
      this.onRuntimeEvent(agentId, e);
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
      this.sessions.delete(agentId);
      this.liveSessions.delete(agentId);
      this.dispatch({ type: "exit", agentId });
    });

    void Promise.resolve(session.start({ text: prompt, sessionId: ctx.config.sessionId }))
      .then(() => {
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
        this.sessions.delete(agentId);
        this.dispatch({ type: "exit", agentId });
      });
  }

  private onRuntimeEvent(agentId: string, e: unknown): void {
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
    }
    // Accumulate the agent's text output onto its latest timeline entry, so the
    // log records "what the agent said" — the basis for using it as memory.
    if (ev.kind === "text" && typeof ev.text === "string" && ev.text.length > 0) {
      this.opts.timeline?.appendResponseToLatest(agentId, ev.text);
    }
    // Any event is progress for stall detection.
    this.dispatch({ type: "progress", agentId, nowMs: this.now() });
    if (ev.kind === "turn_end") {
      this.dispatch({ type: "turn_end", agentId, nowMs: this.now() });
    }
  }
}
