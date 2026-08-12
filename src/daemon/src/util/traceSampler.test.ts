import { describe, it, expect } from "vitest";
import { createTraceSampler, DEFAULT_TRACE_SAMPLE_MS } from "./traceSampler.js";
import * as traceSamplerModule from "./traceSampler.js";

/*
 * T4 (plans/daemon-trace-completeness-charter.md) — heartbeat sampler.
 * Two acceptance conditions (Claudette 架构#421):
 *   ① retention: folding the unchanged-tick / progress / runtime_signal noise
 *      bounds each agent's sampleable streams; the B1 fleet-budget test below
 *      combines that rate with N=8, transition, and turn-span traffic.
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

function operationalRow(
  agentId: string,
  event: string,
  nowMs: number,
  over: Partial<Rec> = {},
): Rec {
  return {
    recordKind: "fsm",
    agentId,
    event,
    status: "running",
    turnActive: true,
    inbox: 0,
    lastDeliverAt: nowMs,
    lastProgressAt: nowMs,
    idleSince: null,
    resetting: false,
    resettingSince: null,
    stoppingSince: null,
    apmPhase: "idle",
    effects: [],
    nowMs,
    timeIso: new Date(nowMs).toISOString(),
    sinceProgressMs: 0,
    sinceDeliverMs: 0,
    sinceStoppingMs: null,
    ...over,
  };
}

function operationalSpanFields(agentIndex: number, turn: number): Rec {
  const daemonTurnOrdinal = agentIndex * 60 + turn + 1;
  return {
    traceTurnId: `launch-${agentIndex}:${daemonTurnOrdinal}`,
    daemonTurnOrdinal,
    spawnOrdinal: agentIndex + 1,
    turnOrdinal: turn + 1,
    launchIdSnapshot: `launch-${agentIndex}`,
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

describe("traceSampler — ① per-agent fold-rate evidence", () => {
  it("bounds one unchanged tick stream to at most 120 rows/hour at the 30s default", () => {
    // Simulate one agent's steady-state over a window and measure the emitted
    // fraction. The B1 budget test multiplies this per-agent ceiling across
    // all three sampleable streams and all eight agents.
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
    // One stream for one agent: 120 rows/h × 362B ≈ 0.041 MiB/h.
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

describe("B1 red gate — turn-span sacred rows", () => {
  it("preserves begin/end/abort fields and flushes a pending tick tail before each boundary", () => {
    const { s, out } = collect(30_000);
    s.offer(tick("a", 0));
    s.offer(tick("a", 5_000, { sinceProgressMs: 5_000 }));
    const begin = {
      recordKind: "turn_span",
      agentId: "a",
      event: "turn_begin",
      traceTurnId: "launch-a:1",
      daemonTurnOrdinal: 1,
      spawnOrdinal: 1,
      turnOrdinal: 1,
      nowMs: 6_000,
      timeIso: "2026-01-01T00:00:06.000Z",
      effects: [],
    };
    const end = { ...begin, event: "turn_end", nowMs: 7_000, timeIso: "2026-01-01T00:00:07.000Z" };
    const abort = { ...begin, event: "turn_abort", nowMs: 8_000, timeIso: "2026-01-01T00:00:08.000Z", abortCause: "physical_exit" };
    s.offer(begin);
    s.offer(tick("a", 6_500, { sinceProgressMs: 6_500 }));
    s.offer(end);
    s.offer(tick("a", 7_500, { sinceProgressMs: 7_500 }));
    s.offer(abort);

    expect(out).toContainEqual(begin);
    expect(out).toContainEqual(end);
    expect(out).toContainEqual(abort);
    expect(out.findIndex((row) => row.event === "tick" && row.nowMs === 5_000)).toBeLessThan(
      out.findIndex((row) => row.event === "turn_begin"),
    );
    expect(out.findIndex((row) => row.event === "tick" && row.nowMs === 6_500)).toBeLessThan(
      out.findIndex((row) => row.event === "turn_end"),
    );
    expect(out.findIndex((row) => row.event === "tick" && row.nowMs === 7_500)).toBeLessThan(
      out.findIndex((row) => row.event === "turn_abort"),
    );
  });

  it("keeps a measured one-hour N=8 operational envelope for at least 12h", () => {
    const productionPerFileCap = Reflect.get(traceSamplerModule, "DEFAULT_TRACE_FILE_MAX_BYTES") as unknown;
    const AGENTS = 8;
    const TURNS_PER_AGENT_HOUR = 60;
    const CLEAN_TURNS_PER_AGENT_HOUR = 54;
    const FAILED_TURNS_PER_AGENT_HOUR = 6;
    const TICK_EVERY_MS = 2_000;
    const ACTIVE_MS_PER_TURN = 20_000;
    // Seven named phases make six phase-change edges per turn. These edges
    // bypass the 30s runtime_signal throttle and therefore belong in the
    // operational upper envelope rather than the steady-stream estimate.
    const PHASES = ["idle", "tool_wait", "idle", "compacting", "idle", "review", "idle"];
    const BASE_EPOCH_MS = Date.UTC(2026, 0, 1);
    const survivors: Rec[] = [];
    const sampler = createTraceSampler(
      (row) => survivors.push(row),
      DEFAULT_TRACE_SAMPLE_MS,
    );

    expect(CLEAN_TURNS_PER_AGENT_HOUR + FAILED_TURNS_PER_AGENT_HOUR).toBe(
      TURNS_PER_AGENT_HOUR,
    );

    for (let agentIndex = 0; agentIndex < AGENTS; agentIndex += 1) {
      const agentId = `agent-${agentIndex}`;
      for (let turn = 0; turn < TURNS_PER_AGENT_HOUR; turn += 1) {
        const turnBaseMs = BASE_EPOCH_MS + turn * 60_000;
        const spanFields = operationalSpanFields(agentIndex, turn);
        sampler.offer(operationalRow(agentId, "wake", turnBaseMs, { turnActive: false }));
        sampler.offer(operationalRow(agentId, "turn_begin", turnBaseMs + 1, {
          recordKind: "turn_span",
          ...spanFields,
        }));

        for (let offsetMs = 0; offsetMs < ACTIVE_MS_PER_TURN; offsetMs += TICK_EVERY_MS) {
          const phaseIndex = Math.min(
            Math.floor(offsetMs / TICK_EVERY_MS),
            PHASES.length - 1,
          );
          sampler.offer(operationalRow(agentId, "progress", turnBaseMs + offsetMs + 100, {
            apmPhase: PHASES[phaseIndex],
            ...spanFields,
          }));
          sampler.offer(operationalRow(agentId, "runtime_signal", turnBaseMs + offsetMs + 200, {
            apmPhase: PHASES[phaseIndex],
            ...spanFields,
          }));
          sampler.offer(operationalRow(agentId, "tick", turnBaseMs + offsetMs + 300, {
            turnActive: true,
            apmPhase: PHASES[phaseIndex],
            ...spanFields,
          }));
        }

        const failed = turn % 10 === 9;
        sampler.offer(operationalRow(
          agentId,
          failed ? "exit" : "turn_end",
          turnBaseMs + ACTIVE_MS_PER_TURN + 1,
          { turnActive: false, ...spanFields },
        ));
        sampler.offer(operationalRow(
          agentId,
          failed ? "turn_abort" : "turn_end",
          turnBaseMs + ACTIVE_MS_PER_TURN + 2,
          {
            recordKind: "turn_span",
            turnActive: false,
            ...spanFields,
            ...(failed ? { abortCause: "physical_exit" } : { outcome: "clean" }),
          },
        ));
        for (
          let offsetMs = ACTIVE_MS_PER_TURN;
          offsetMs < 60_000;
          offsetMs += TICK_EVERY_MS
        ) {
          sampler.offer(operationalRow(agentId, "tick", turnBaseMs + offsetMs + 300, {
            turnActive: false,
            apmPhase: PHASES.at(-1),
          }));
        }
      }
      // Flush the final pending idle-tick tail at the one-hour boundary.
      sampler.offer(operationalRow(agentId, "wake", BASE_EPOCH_MS + 3_600_000, {
        turnActive: false,
      }));
    }

    const count = (event: string, recordKind?: string): number => survivors.filter(
      (row) => row.event === event && (recordKind === undefined || row.recordKind === recordKind),
    ).length;
    const serializedBytesPerHour = survivors.reduce(
      (total, row) => total + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
      0,
    );
    for (let agentIndex = 0; agentIndex < AGENTS; agentIndex += 1) {
      const agentRows = survivors.filter((row) => row.agentId === `agent-${agentIndex}`);
      for (let index = 1; index < agentRows.length; index += 1) {
        expect(agentRows[index]!.nowMs).toBeGreaterThanOrEqual(agentRows[index - 1]!.nowMs);
      }
    }

    expect(DEFAULT_TRACE_SAMPLE_MS).toBe(30_000);
    expect(PHASES.length - 1).toBe(6);
    expect(count("runtime_signal")).toBe(AGENTS * TURNS_PER_AGENT_HOUR * PHASES.length);
    expect(count("progress")).toBe(AGENTS * TURNS_PER_AGENT_HOUR);
    // Five retained ticks per turn mechanically includes state-change edges,
    // throttle survivors, and the pending tail flushed by the next boundary.
    expect(count("tick")).toBe(AGENTS * TURNS_PER_AGENT_HOUR * 5);
    expect(count("turn_begin", "turn_span")).toBe(AGENTS * TURNS_PER_AGENT_HOUR);
    expect(count("turn_end", "turn_span")).toBe(AGENTS * CLEAN_TURNS_PER_AGENT_HOUR);
    expect(count("turn_abort", "turn_span")).toBe(AGENTS * FAILED_TURNS_PER_AGENT_HOUR);
    expect(survivors).toHaveLength(8_168);
    expect(serializedBytesPerHour).toBe(4_010_728);

    expect(productionPerFileCap).toBe(32 * 1024 * 1024);
    if (typeof productionPerFileCap !== "number") return;
    const retainedHours = (productionPerFileCap * 2) / serializedBytesPerHour;
    expect(retainedHours).toBeGreaterThanOrEqual(12);
  });
});
