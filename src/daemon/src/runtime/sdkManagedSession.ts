/**
 * SdkManagedSession — bridges an in-process SDK driver's `createSession` into
 * the `ManagedSession` contract `AgentProcessManager.doSpawn` drives, the same
 * way `ChildProcessRuntimeSession` does for CLI drivers.
 *
 * The manager subscribes to `"runtime_event"`/`"error"`/`"exit"` right after
 * construction, BEFORE calling `.start()` (see `managerRuntime.ts::doSpawn`).
 * This class's own `EventEmitter` exists from construction for exactly that
 * reason: `.on()` calls made before `.start()` resolves are never missed.
 *
 * `.start()` then does, in order: (1) call `driver.createSession()` — which
 * builds and wires the vendor SDK session but does NOT fire the first turn —
 * (2) proxy the returned session's events through to this adapter's emitter,
 * (3) only THEN send the first turn via `.send(text, "idle")`. That ordering
 * is what fixes the event-loss bug a driver could otherwise hit: a plain
 * `EventEmitter.emit()` (unlike a child process's buffered stdout pipe) drops
 * events fired before any listener is attached.
 *
 * `.start()` does NOT await that first `.send()` to completion — it resolves
 * as soon as the turn is ACCEPTED, mirroring `ChildProcessRuntimeSession`
 * (whose `.start()` resolves once the process is spawned, not once it exits).
 * `AgentProcessManager` only dispatches `{type: "spawned"}` after `.start()`
 * resolves, and only *that* dispatch makes the manager treat the agent as
 * "busy" for the duration of the turn. Awaiting the whole turn here — a
 * vendor SDK's `prompt()` doesn't resolve until the turn (incl. tool calls)
 * finishes — delayed that dispatch by the entire turn length, so a wake that
 * arrived mid-turn wasn't recognized as "steer a running agent" and instead
 * got queued until turn_end, where it was misrouted as an `idle` send into an
 * agent the vendor SDK still considered mid-turn — throwing "Agent is
 * already processing". A rejected first turn is reported via the `"error"`
 * event instead (same path `doSpawn`'s pre-handshake `error` listener uses).
 */
import { EventEmitter } from "events";
import type { Driver, LaunchContext, SdkDriverDeps } from "../types.js";
import type { SdkRuntimeSession } from "./sdkRuntimeSession.js";

type SdkCapableDriver = Driver & { createSession: NonNullable<Driver["createSession"]> };

export class SdkManagedSession {
  private readonly events = new EventEmitter();
  private inner: SdkRuntimeSession | null = null;
  private startedSessionId: string | null = null;
  private exited = false;
  // Set synchronously (before any `await`) by `start()`. `stop()` awaits
  // this so it never disposes/exits while `driver.createSession()` is still
  // in flight — see `stop()`'s doc comment for why that matters.
  private starting: Promise<void> | null = null;
  private stopRequested = false;
  // Set synchronously (before any `await`) by `stop()`. `start()` awaits
  // this — when it sees `stopRequested` — before resolving, so it can never
  // resolve "successfully" in the gap between a racing `stop()` skipping the
  // first turn and that same `stop()` actually finishing disposal + emitting
  // `"exit"`. Without this, `doSpawn`'s `.then()` would see `start()`
  // resolve WHILE the session is still tracked in the manager's map (`stop()`
  // hasn't reached `emitExit()`'s synchronous `this.sessions.delete()` yet)
  // and dispatch `{type: "spawned"}` — a real, if brief, "running" state for
  // a session that never actually ran a turn and is already being torn down.
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly driver: SdkCapableDriver,
    private readonly ctx: LaunchContext,
    private readonly deps: SdkDriverDeps,
  ) { }

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.events.on(event, cb);
  }

  async start(input: { text: string; sessionId?: string }): Promise<{ ok: boolean }> {
    const launchCtx: LaunchContext = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    // `managerRuntime.ts::doSpawn` puts this session into its map BEFORE
    // this promise settles, so a `stop()` (effect-driven or the public
    // `AgentProcessManager.stop()`) can legitimately race a still-in-flight
    // `driver.createSession()`. Stashing the promise lets `stop()` wait for
    // `this.inner` to actually exist instead of disposing nothing and
    // leaving this call free to wire up and prompt a session nobody tracks
    // anymore.
    this.starting = (async () => {
      const inner = await this.driver.createSession(launchCtx, this.deps);
      this.inner = inner;
      this.startedSessionId = inner.currentSessionId;
      inner.on("runtime_event", (...args: unknown[]) => this.events.emit("runtime_event", ...args));
    })();
    await this.starting;
    if (this.stopRequested) {
      // A stop() raced this start() — don't fire a turn into a session
      // that's already being torn down, and don't resolve until that
      // teardown (disposal + `"exit"`) has fully finished (see `stopping`'s
      // doc comment above for why resolving any earlier is unsafe).
      if (this.stopping) await this.stopping.catch(() => { });
      return { ok: true };
    }
    // Fire-and-forget — see the class doc comment for why this must NOT be
    // awaited. A rejection (e.g. the vendor SDK throwing before any
    // runtime_event ever fires) surfaces as an "error" event instead.
    void this.inner!.send(input.text, "idle").catch((err: unknown) => this.events.emit("error", err));
    return { ok: true };
  }

  send(input: { text: string; mode: "busy" | "idle" }): { ok: boolean; reason?: string } {
    if (!this.inner) return { ok: false, reason: "not_started" };
    void this.inner.send(input.text, input.mode).catch((err: unknown) => this.events.emit("error", err));
    return { ok: true };
  }

  /**
   * Unlike `ChildProcessRuntimeSession` — where killing the process makes the
   * OS emit its own `exit` shortly after, which is what actually notifies
   * `managerRuntime.ts`'s `session.on("exit", ...)` listener — there's no
   * underlying process here to do that for us. `inner.dispose()` just frees
   * SDK resources; it doesn't fire anything on `this.events`. So `stop()`
   * must emit `"exit"` itself once disposal settles (even if it throws),
   * or the manager's exit listener never runs: the session is never removed
   * from `AgentProcessManager`'s map and the FSM never leaves "stopping".
   *
   * `stopRequested` is set synchronously (before awaiting `starting`) so a
   * `start()` that's still mid-flight sees it as soon as `driver.createSession()`
   * resolves and skips firing the first turn (see `start()`).
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.stopping = (async () => {
      try {
        if (this.starting) await this.starting.catch(() => { });
        await this.inner?.stop();
      } finally {
        this.emitExit();
      }
    })();
    await this.stopping;
  }

  private emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit("exit");
  }

  get currentSessionId(): string | null {
    return this.inner?.currentSessionId ?? this.startedSessionId;
  }
}
