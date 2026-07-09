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
 * Why this exists: `PiDriver` and `CodexDriver` both declare
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
 * that capability profile today (Pi, Codex) and any future one, without
 * needing driver-specific test plumbing.
 */
import { describe, it, expect } from "vitest";
import { AgentProcessManager, type ManagedSession, type SessionFactory } from "./managerRuntime.js";
import { listRuntimeIds, getDriver } from "../drivers/index.js";
import type { Driver, LaunchContext } from "../types.js";

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

function makeManager(driver: Driver, session: FakeSession) {
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
     * KNOWN GAP — not the bug this plan set out to fix, but found while
     * writing a contract test that assumed `lifecycle.stdin: "gated"` /
     * `inFlightWake: "queue"` changed the manager's delivery timing the way
     * Claude's own doc comment implies ("held until a safe boundary — see
     * runtime/apmStateMachine and runtime/turnState"). It doesn't:
     * `managerPolicy.ts::onWake`'s "running" branch only checks
     * `lifecycleKind === "persistent" && supportsStdinNotification` — it
     * never reads `inFlightWake` or `busyDeliveryMode` — so a gated driver's
     * mid-turn wake is sent exactly as immediately as a direct/steer one.
     * `ChildProcessRuntimeSession.send()` also writes to stdin unconditionally,
     * regardless of mode. `apmStateMachine.ts`/`turnState.ts` exist in this
     * package (exported from `index.ts`) but have ZERO call sites in
     * `managerRuntime.ts`/`runtimeSession.ts` — they're a real, tested reducer
     * that's wired up in the OTHER daemon implementation
     * (`src/cli/daemon/session-runner.ts` branches on `busyMode === "gated"`
     * and drives `apmStateMachine`/`turnState` for real) but were never
     * connected here. This test asserts what ACTUALLY happens today (not
     * what the naming implies) precisely so it breaks loudly — instead of
     * silently drifting further — if/when gating is either wired up for
     * real or intentionally dropped from the type model.
     */
    it(`[${label}] TODAY sends a mid-turn wake immediately (mode:"busy"), identically to a direct/steer runtime — "gated" delivery is declared but not wired up in this package's ManagedSession path`, async () => {
      const session = fakeSession();
      const mgr = makeManager(bucket.sample, session);

      mgr.deliver("a1", { seq: 1, text: "first" });
      session.startResolver?.();
      await Promise.resolve();

      mgr.deliver("a1", { seq: 2, text: "mid-turn wake" });

      expect(session.sendCalls).toEqual([{ text: "mid-turn wake", mode: "busy" }]);
    });
  }
});

describe("AgentProcessManager capability contract — bucket sanity", () => {
  it("the registered drivers still contain at least one direct/steer profile and one gated/queue profile (catches an accidental capability drift silently disabling the contracts above)", () => {
    expect(directSteerBuckets.length).toBeGreaterThan(0);
    expect(gatedQueueBuckets.length).toBeGreaterThan(0);
  });
});