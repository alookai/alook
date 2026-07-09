/**
 * Driver-agnostic contract tests for `AgentProcessManager`'s busy/idle
 * delivery orchestration — see plans/manager-persistent-direct-contract-test.md.
 *
 * These tests don't target one driver file; they group the REAL drivers from
 * `drivers/index.ts` by their declared `AgentRuntimeCaps`-relevant profile
 * (`lifecycle.kind`/`stdin`/`inFlightWake`, `supportsStdinNotification`,
 * `busyDeliveryMode`) and drive `AgentProcessManager` itself (via a
 * `sessionFactory`, bypassing real process/SDK spawning) to assert the
 * orchestration contract each profile is supposed to get.
 *
 * Why this exists: `PiDriver` and `KimiDriver` both declare
 * `{kind: "persistent", stdin: "direct", inFlightWake: "steer"}` +
 * `busyDeliveryMode: "direct"`. A real production bug shipped because
 * `SdkManagedSession.start()` (Pi's session adapter) used to await the
 * ENTIRE first turn before resolving, which delayed `AgentProcessManager`
 * dispatching `{type: "spawned"}` (the thing that makes it treat the agent
 * as busy) until the turn was already over — so a wake that arrived mid-turn
 * was queued instead of steered, then misrouted as an `idle` send right
 * after `turn_end`, racing the vendor SDK's own "already processing" guard.
 * That fix lives in `sdkManagedSession.ts`/`pi.ts` and is regression-tested
 * in `sdkManagedSession.test.ts` — but that only protects Pi. This file
 * protects the *manager's* half of the contract for EVERY driver sharing
 * that capability profile today (Pi and Kimi declare direct/steer; Codex
 * joins Claude in the gated/queue bucket — see
 * plans/wire-gated-busy-steering-daemon.md) and any future one, without
 * needing driver-specific test plumbing.
 */
import { describe, it, expect } from "vitest";
import { AgentProcessManager, type ManagedSession, type SessionFactory } from "./managerRuntime.js";
import { listRuntimeIds, getDriver } from "../drivers/index.js";
import type { Driver, LaunchContext } from "../types.js";
import type { Logger } from "../logger.js";

interface CapabilityProfile {
  lifecycleKind: "persistent" | "per_turn";
  stdin?: "direct" | "gated";
  inFlightWake: string;
  supportsStdinNotification: boolean;
  busyDeliveryMode: "direct" | "gated" | "none";
}

function profileOf(driver: Driver): CapabilityProfile {
  const lifecycle = driver.lifecycle;
  return {
    lifecycleKind: lifecycle.kind,
    stdin: lifecycle.kind === "persistent" ? lifecycle.stdin : undefined,
    inFlightWake: lifecycle.inFlightWake,
    supportsStdinNotification: driver.supportsStdinNotification,
    busyDeliveryMode: driver.busyDeliveryMode,
  };
}

/** Group every registered driver by its capability profile (dedup key). */
function capabilityBuckets(): Array<{ profile: CapabilityProfile; driverIds: string[]; sample: Driver }> {
  const buckets = new Map<string, { profile: CapabilityProfile; driverIds: string[]; sample: Driver }>();
  for (const id of listRuntimeIds()) {
    const driver = getDriver(id);
    const profile = profileOf(driver);
    const key = JSON.stringify(profile);
    const existing = buckets.get(key);
    if (existing) existing.driverIds.push(id);
    else buckets.set(key, { profile, driverIds: [id], sample: driver });
  }
  return [...buckets.values()];
}

function isDirectSteerProfile(p: CapabilityProfile): boolean {
  return (
    p.lifecycleKind === "persistent" &&
    p.stdin === "direct" &&
    p.inFlightWake === "steer" &&
    p.supportsStdinNotification &&
    p.busyDeliveryMode === "direct"
  );
}

function isGatedQueueProfile(p: CapabilityProfile): boolean {
  return (
    p.lifecycleKind === "persistent" &&
    p.stdin === "gated" &&
    p.inFlightWake === "queue" &&
    p.supportsStdinNotification &&
    p.busyDeliveryMode === "gated"
  );
}

/** Controllable fake `ManagedSession` — records every `send()` call and lets
 * the test decide exactly when `.start()` resolves, independent of whether
 * any "turn_end" has fired. This is what lets these tests exercise the
 * manager's contract without a real child process or SDK. */
interface FakeSession extends ManagedSession {
  fire(evt: string, ...args: unknown[]): void;
  startResolver?: () => void;
  sendCalls: Array<{ text: string; mode: "busy" | "idle" }>;
}

function fakeSession(): FakeSession {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const s: FakeSession = {
    sendCalls: [],
    on(event, cb) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    start() {
      return new Promise<void>((resolve) => {
        s.startResolver = resolve;
      });
    },
    send(input) {
      s.sendCalls.push(input);
    },
    stop() { },
    get currentSessionId() {
      return "sess_1";
    },
    fire(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) cb(...args);
    },
  };
  return s;
}

/** Stub logger — records calls per level for assertions (copied from
 * `managerRuntime.test.ts`; kept local so these two test files don't need to
 * import from each other). */
function stubLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> } {
  const calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const logger = {
    calls,
    debug: (m: string, ...d: unknown[]) => calls.debug.push([m, d]),
    info: (m: string, ...d: unknown[]) => calls.info.push([m, d]),
    warn: (m: string, ...d: unknown[]) => calls.warn.push([m, d]),
    error: (m: string, ...d: unknown[]) => calls.error.push([m, d]),
    child: () => logger,
  };
  return logger;
}

function makeManager(driver: Driver, session: FakeSession, logger?: Logger) {
  const factory: SessionFactory = () => session;
  const mgr = new AgentProcessManager({
    driverFor: () => driver,
    baseContextFor: () => ({
      workingDirectory: "/tmp/agent_1",
      agentId: "a1",
      standingPrompt: "",
      config: {} as LaunchContext["config"],
    }),
    sessionFactory: factory,
    logger,
  });
  mgr.register("a1");
  return mgr;
}

const buckets = capabilityBuckets();
const directSteerBuckets = buckets.filter((b) => isDirectSteerProfile(b.profile));
const gatedQueueBuckets = buckets.filter((b) => isGatedQueueProfile(b.profile));

describe("AgentProcessManager capability contract — persistent/direct/steer runtimes", () => {
  if (directSteerBuckets.length === 0) {
    it.skip("no driver currently declares this profile", () => { });
  }

  for (const bucket of directSteerBuckets) {
    const label = bucket.driverIds.join(", ");

    it(`[${label}] a wake delivered after the session is running (start() resolved, no turn_end yet) is steered immediately as mode:"busy" — not queued until turn_end`, async () => {
      const session = fakeSession();
      const mgr = makeManager(bucket.sample, session);

      mgr.deliver("a1", { seq: 1, text: "first" });
      // Simulate the FIXED contract: start() resolves once the turn is
      // accepted, well before the underlying turn (whatever it does) is
      // actually done. No "turn_end" runtime_event fires in this test.
      session.startResolver?.();
      await Promise.resolve();

      mgr.deliver("a1", { seq: 2, text: "mid-turn wake" });

      expect(session.sendCalls).toEqual([{ text: "mid-turn wake", mode: "busy" }]);
    });

    it(`[${label}] a wake delivered before start() resolves is queued (not sent early) and is coalesced into exactly one delivery once running`, async () => {
      const session = fakeSession();
      const mgr = makeManager(bucket.sample, session);

      mgr.deliver("a1", { seq: 1, text: "first" }); // triggers spawn; status -> "starting"
      mgr.deliver("a1", { seq: 2, text: "queued while starting" }); // status still "starting" -> queued, no send yet
      expect(session.sendCalls).toEqual([]);

      session.startResolver?.();
      await Promise.resolve();
      // Now running. A further wake should coalesce with the queued one into
      // a single busy send, not one send per queued message.
      mgr.deliver("a1", { seq: 3, text: "after running" });

      expect(session.sendCalls).toEqual([
        { text: "queued while starting\nafter running", mode: "busy" },
      ]);
    });
  }
});

describe("AgentProcessManager capability contract — persistent/gated/queue runtimes", () => {
  if (gatedQueueBuckets.length === 0) {
    it.skip("no driver currently declares this profile", () => { });
  }

  for (const bucket of gatedQueueBuckets) {
    const label = bucket.driverIds.join(", ");

    /**
     * FIXED (see plans/wire-gated-busy-steering-daemon.md) — a mid-turn wake
     * on a gated driver is HELD, not sent immediately. `managerPolicy.ts`'s
     * `onWake` running branch now checks `busyDeliveryMode === "gated" &&
     * turnActive` and emits `gated_hold` instead of draining the inbox. The
     * message flows to stdin only once a safe boundary is reached — here, a
     * `tool_call`→`tool_output` pair closing the last outstanding tool use —
     * and only once a `session_init` runtime event has landed (`hasSession`
     * is a `reduceApmGatedFlushReadiness` prerequisite). This test drives
     * that whole path through the public `AgentProcessManager` + a fake
     * session (not just the pure reducer), proving the executor's
     * `runtime_signal` forwarding AND the `gated_hold` logging path (via an
     * injected logger spy) both work end to end.
     */
    it(`[${label}] holds a mid-turn wake until a safe boundary (session_init, then tool_call/tool_output) instead of sending immediately`, async () => {
      const session = fakeSession();
      const logger = stubLogger();
      const mgr = makeManager(bucket.sample, session, logger);

      mgr.deliver("a1", { seq: 1, text: "first" });
      session.startResolver?.();
      await Promise.resolve();
      session.fire("runtime_event", { kind: "session_init", sessionId: "sess_1" });

      mgr.deliver("a1", { seq: 2, text: "mid-turn wake" });

      // Held, not sent — and a gated_hold was logged for the mid-turn wake.
      expect(session.sendCalls).toEqual([]);
      expect(
        logger.calls.info.some(
          ([m, d]) => m === "gated busy message held" && (d[0] as any).reason === "mid_turn_wake",
        ),
      ).toBe(true);

      // A tool_call/tool_output pair is the next safe boundary — the
      // single outstanding tool closes, readiness passes, the held message
      // flushes as mode:"busy".
      session.fire("runtime_event", { kind: "tool_call", name: "shell", input: {} });
      session.fire("runtime_event", { kind: "tool_output", name: "shell" });

      expect(session.sendCalls).toEqual([{ text: "mid-turn wake", mode: "busy" }]);
    });
  }
});

describe("AgentProcessManager capability contract — Codex fileChange tool_call/tool_output fix (§9c)", () => {
  /**
   * Proves 9c's fix end to end, not just its `ParsedEvent` shape (that part
   * is covered by `codexEventNormalizer.test.ts`): before the fix,
   * `handleItemCompleted` had no `fileChange` case, so a `fileChange`
   * `tool_call` would open `outstandingToolUses` and it would never close —
   * permanently blocking mid-turn flushes for the rest of that turn. Uses
   * the real `CodexDriver` capability profile via the same fake-session
   * harness as the gated/queue bucket tests above.
   */
  it("a fileChange tool_call immediately followed by its tool_output closes outstandingToolUses back to 0 and unblocks a held message", async () => {
    const codexDriver = getDriver("codex");
    const session = fakeSession();
    const mgr = makeManager(codexDriver, session);

    mgr.deliver("a1", { seq: 1, text: "first" });
    session.startResolver?.();
    await Promise.resolve();
    session.fire("runtime_event", { kind: "session_init", sessionId: "sess_1" });

    mgr.deliver("a1", { seq: 2, text: "mid-turn wake" });
    expect(session.sendCalls).toEqual([]); // held — gated mid-turn wake

    session.fire("runtime_event", { kind: "tool_call", name: "file_change", input: {} });
    session.fire("runtime_event", { kind: "tool_output", name: "file_change" });

    expect(session.sendCalls).toEqual([{ text: "mid-turn wake", mode: "busy" }]);
  });
});

describe("AgentProcessManager capability contract — bucket sanity", () => {
  it("the registered drivers still contain at least one direct/steer profile and one gated/queue profile (catches an accidental capability drift silently disabling the contracts above)", () => {
    expect(directSteerBuckets.length).toBeGreaterThan(0);
    expect(gatedQueueBuckets.length).toBeGreaterThan(0);
  });

  it("the gated/queue bucket contains BOTH claude and codex, sharing one identical profile (see plans/wire-gated-busy-steering-daemon.md §9a) — catches a future capability drift between the two silently splitting the bucket", () => {
    expect(gatedQueueBuckets).toHaveLength(1);
    expect(gatedQueueBuckets[0]!.driverIds.slice().sort()).toEqual(["claude", "codex"]);
  });

  it("the direct/steer bucket contains exactly pi and kimi — codex moved to gated/queue, NOT just pi alone", () => {
    expect(directSteerBuckets.flatMap((b) => b.driverIds).sort()).toEqual(["kimi", "pi"]);
  });
});
