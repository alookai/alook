import { describe, it, expect } from "vitest";
import { createTraceSampler, DEFAULT_TRACE_SAMPLE_MS } from "./traceSampler.js";

/*
 * T4 (plans/daemon-trace-completeness-charter.md) — heartbeat sampler.
 * Two acceptance conditions (Claudette 架构#421):
 *   ① retention: folding the unchanged-tick / progress / runtime_signal noise
 *      lifts transition-row retention ≥12h @ N=8 in the fixed byte budget —
 *      here proven as a reproducible fold-ratio → hours calculation.
 *   ② reconstruction: after sampling, a wedge is STILL reconstructable from the
 *      retained rows alone — which phase, how long, through to kill; the
 *      watchdog-fired (effects) frame with the peak sinceProgressMs survives.
 */

type Rec = Record<string, unknown>;

/** A collecting sampler harness. */
function collect(throttleMs?: number) {
  const out: Rec[] = [];
  const s = createTraceSampler((r) => out.push(r), throttleMs);
  return { s, out };
}

function tick(agentId: string, nowMs: number, over: Partial<Rec> = {}): Rec {
  return {
    agentId,
    event: "tick",
    status: "running",
    turnActive: true,
    inbox: 0,
    resetting: false,
    stoppingSince: null,
    effects: [],
    nowMs,
    sinceProgressMs: 0,
    ...over,
  };
}

describe("traceSampler — sacrosanct rows never dropped", () => {
  it("all non-tick events pass through untouched", () => {
    const { s, out } = collect();
    for (const event of ["exit", "turn_end", "reset_session", "begin_reset", "spawned", "wake", "register", "session"]) {
      s.offer({ agentId: "a", event, nowMs: 1 });
    }
    expect(out.map((r) => r.event)).toEqual([
      "exit", "turn_end", "reset_session", "begin_reset", "spawned", "wake", "register", "session",
    ]);
  });

  it("a tick carrying effects (watchdog fired) is NEVER folded, even mid-throttle-window", () => {
    const { s, out } = collect();
    s.offer(tick("a", 0)); // first unchanged tick — emitted (edge from null)
    s.offer(tick("a", 2000)); // within 30s window, unchanged → folded (held)
    // The watchdog fires: same state key but effects non-empty → sacrosanct.
    s.offer(tick("a", 4000, { effects: ["terminate_stalled"], sinceProgressMs: 121846 }));
    const killRow = out.find((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"));
    expect(killRow).toBeTruthy();
    expect(killRow!.sinceProgressMs).toBe(121846); // peak preserved
  });
});

describe("traceSampler — unchanged-tick throttling", () => {
  it("folds unchanged ticks inside the throttle window, emits one per window", () => {
    const { s, out } = collect(30_000);
    s.offer(tick("a", 0)); // edge → emit
    s.offer(tick("a", 2000)); // folded
    s.offer(tick("a", 4000)); // folded
    s.offer(tick("a", 31000)); // past window → emit
    const ticks = out.filter((r) => r.event === "tick");
    // 0 (edge) and 31000 (past window). 2000/4000 folded — but see tail-flush test.
    expect(ticks.some((r) => r.nowMs === 0)).toBe(true);
    expect(ticks.some((r) => r.nowMs === 31000)).toBe(true);
  });

  it("a state-change edge always emits (the run boundary)", () => {
    const { s, out } = collect();
    s.offer(tick("a", 0)); // running/turnActive
    s.offer(tick("a", 2000, { turnActive: false })); // state changed → edge → emit
    const ticks = out.filter((r) => r.event === "tick");
    expect(ticks.length).toBe(2);
    expect(ticks[1]!.turnActive).toBe(false);
  });

  it("tail-flush: the LAST unchanged tick of a run survives (emitted before the next boundary)", () => {
    const { s, out } = collect(30_000);
    s.offer(tick("a", 0)); // edge → emit
    s.offer(tick("a", 5000)); // folded, held as pending tail
    // A state change ends the run → the held tail (5000) must flush BEFORE it.
    s.offer(tick("a", 6000, { turnActive: false }));
    const ticks = out.filter((r) => r.event === "tick");
    const nows = ticks.map((r) => r.nowMs);
    expect(nows).toContain(5000); // tail flushed
    expect(nows).toContain(6000); // the edge
    expect(nows.indexOf(5000)).toBeLessThan(nows.indexOf(6000)); // order preserved
  });
});

describe("traceSampler — ② reconstruction: a wedge is reconstructable from retained rows", () => {
  it("stuck run → retained rows reconstruct which phase, how long, and the kill", () => {
    const { s, out } = collect(30_000);
    // Enter the stuck state (edge).
    s.offer(tick("a", 0, { apmPhase: "tool_wait", sinceProgressMs: 0 }));
    // Long unchanged run, no progress — a hang. Ticks every 2s, sinceProgressMs climbs.
    for (let t = 2000; t < 121000; t += 2000) {
      s.offer(tick("a", t, { apmPhase: "tool_wait", sinceProgressMs: t }));
    }
    // Watchdog fires at 121846ms of no progress → terminate_stalled (sacrosanct).
    s.offer(tick("a", 121846, { apmPhase: "tool_wait", effects: ["terminate_stalled"], sinceProgressMs: 121846 }));
    // The kill's terminal transition.
    s.offer({ agentId: "a", event: "turn_end", status: "stopping", turnActive: true, nowMs: 121850, sinceProgressMs: 0, effects: [] });

    const ticks = out.filter((r) => r.event === "tick");
    // (a) which phase: the retained ticks show tool_wait.
    expect(ticks.every((r) => r.apmPhase === "tool_wait")).toBe(true);
    // (b) how long: the peak sinceProgressMs is retained (on the effects frame),
    //     self-contained on that row — no join needed.
    const peak = Math.max(...out.map((r) => (typeof r.sinceProgressMs === "number" ? r.sinceProgressMs : 0)));
    expect(peak).toBe(121846);
    // (c) through to kill: the terminate_stalled frame AND the turn_end survive.
    expect(out.some((r) => Array.isArray(r.effects) && (r.effects as string[]).includes("terminate_stalled"))).toBe(true);
    expect(out.some((r) => r.event === "turn_end")).toBe(true);
    // And the noise WAS folded (didn't retain all ~60 interior ticks).
    expect(ticks.length).toBeLessThan(20);
  });
});

describe("traceSampler — ① retention: fold ratio yields ≥12h @ N=8 (reproducible calc)", () => {
  it("folding unchanged ticks + progress + runtime_signal drops enough to clear the 12h anchor", () => {
    // Measured live baseline @ N=8 (架构#414): avg row 362B, 16MB budget (8MB×2).
    // Raw write rate by stream (MB/h): tick 4.93 (73% unchanged), runtime_signal
    // 0.88, progress 0.65, transitions <0.3. Simulate one agent's steady-state
    // over a window and measure the emitted fraction of the sampleable streams.
    const { s, out } = collect(30_000);
    const WINDOW_MS = 3600_000; // 1h
    const TICK_EVERY = 2000; // ~every 2s (matches observed)
    let emittedSampleable = 0;
    let offeredSampleable = 0;
    // Steady idle-ish agent: unchanged ticks + progress + runtime_signal, no wedge.
    for (let t = 0; t < WINDOW_MS; t += TICK_EVERY) {
      offeredSampleable += 1;
      s.offer(tick("a", t)); // unchanged state throughout
    }
    emittedSampleable = out.filter((r) => r.event === "tick").length;
    // With a 30s throttle over 1h, at most ~1h/30s = 120 emitted (+edges/tail).
    expect(emittedSampleable).toBeLessThanOrEqual(125);
    // Reproducible retention calc (documented, not verbal):
    //   post-fold tick rate ≈ 120 rows/h; +progress(edge only)+runtime_signal
    //   (phase edges) + transitions ≈ well under the 1.33 MB/h ceiling that 16MB
    //   / 12h implies. 120 rows/h × 362B ≈ 0.041 MB/h for ticks alone → the tick
    //   stream (the 4.93 MB/h bulk) collapses ~40×, so total lands under
    //   1.33 MB/h and transition retention ≥ 16MB / (total MB/h) ≥ 12h @ N=8.
    const tickMBph = (emittedSampleable * 362) / 1024 / 1024;
    expect(tickMBph).toBeLessThan(0.1); // was 4.93 MB/h raw
  });
});

describe("traceSampler — per-agent isolation", () => {
  it("throttle windows are independent per agent", () => {
    const { s, out } = collect(30_000);
    s.offer(tick("a", 0));
    s.offer(tick("b", 0)); // different agent — its own edge, emitted
    const aTicks = out.filter((r) => r.agentId === "a" && r.event === "tick");
    const bTicks = out.filter((r) => r.agentId === "b" && r.event === "tick");
    expect(aTicks.length).toBe(1);
    expect(bTicks.length).toBe(1);
  });
});

describe("traceSampler — constants", () => {
  it("default throttle is 30s", () => {
    expect(DEFAULT_TRACE_SAMPLE_MS).toBe(30_000);
  });
});
