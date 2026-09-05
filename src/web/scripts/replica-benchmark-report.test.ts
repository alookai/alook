import { describe, expect, it } from "vitest"
import {
  analyzeReplicaBenchmark,
  artifactCompatibilityFailures,
  percentile,
  renderReplicaBenchmarkReport,
  sampleLatency,
  userBlockingGets,
} from "./replica-benchmark-report"
import {
  REPLICA_BENCHMARK_SCHEMA_VERSION,
  type ReplicaBenchmarkArtifact,
  type ReplicaBenchmarkSample,
  type ReplicaScenarioContract,
} from "../src/test/e2e-ui/perf/replica-benchmark-types"

const contract: ReplicaScenarioContract = {
  id: "j6-text-send",
  label: "Text send",
  anchor: "durable-coherent",
  absoluteMaxMs: 50,
  maxBaselineRatio: 0.1,
  minSamples: 1,
  requiredProofs: ["intent-durable", "canonical-row-matches"],
  requireCanonicalOutcome: true,
  requireSingleBusinessEffect: true,
  requireZeroBlockingGets: true,
}

function sample(overrides: Partial<ReplicaBenchmarkSample> = {}): ReplicaBenchmarkSample {
  return {
    scenario: "j6-text-send",
    iteration: 1,
    actionAtMs: 1_000,
    interactiveCoherentAtMs: 1_020,
    localDurableAtMs: 1_018,
    baselineObservedAtMs: null,
    canonicalOutcomeAtMs: 2_500,
    requests: [],
    manualRecoveryActions: [],
    proofs: [
      { id: "intent-durable", passed: true, evidence: "IDB intent n1" },
      { id: "canonical-row-matches", passed: true, evidence: "D1 row m1" },
    ],
    canonicalOutcomeCount: 1,
    businessEffectCount: 1,
    transportDeliveryCount: 2,
    observationEndedAtMs: 2_500,
    productFailure: null,
    harnessError: null,
    ...overrides,
  }
}

function artifact(
  mode: ReplicaBenchmarkArtifact["mode"],
  samples: ReplicaBenchmarkSample[] = [sample()],
  overrides: Partial<ReplicaBenchmarkArtifact> = {},
): ReplicaBenchmarkArtifact {
  return {
    schemaVersion: REPLICA_BENCHMARK_SCHEMA_VERSION,
    contractVersion: "replica-v1",
    fixtureVersion: "stress-v1",
    selectedScenarios: ["j6-text-send"],
    createdAt: "2026-09-06T00:00:00.000Z",
    gitSha: "abc123",
    mode,
    networkDelayMs: 1_000,
    samples,
    ...overrides,
  }
}

describe("percentile", () => {
  it("uses a deterministic nearest-rank percentile", () => {
    expect(percentile([50, 10, 30, 20, 40], 0.5)).toBe(30)
    expect(percentile([50, 10, 30, 20, 40], 0.95)).toBe(50)
    expect(percentile([], 0.95)).toBeNull()
  })
})

describe("durable-coherent timing", () => {
  it("uses the later of durable commit and coherent paint", () => {
    expect(sampleLatency(sample({
      actionAtMs: 1_000,
      localDurableAtMs: 1_030,
      interactiveCoherentAtMs: 1_042,
    }), "durable-coherent")).toBe(42)
    expect(sampleLatency(sample({
      actionAtMs: 1_000,
      localDurableAtMs: 1_047,
      interactiveCoherentAtMs: 1_020,
    }), "durable-coherent")).toBe(47)
  })

  it("rejects memory-only paint when durable commit evidence is absent", () => {
    expect(sampleLatency(sample({ localDurableAtMs: null }), "durable-coherent")).toBeNull()
  })

  it("uses explicit legacy completion only for a baseline", () => {
    const measured = sample({
      interactiveCoherentAtMs: 1_020,
      localDurableAtMs: null,
      baselineObservedAtMs: 2_100,
    })
    expect(sampleLatency(measured, "durable-coherent", "baseline")).toBe(1_100)
    expect(sampleLatency(measured, "durable-coherent", "gate")).toBeNull()
  })
})

describe("baseline and gate semantics", () => {
  it("records an honest slow baseline without failing the harness run", () => {
    const result = analyzeReplicaBenchmark(
      artifact("baseline", [sample({ interactiveCoherentAtMs: 2_000, localDurableAtMs: 1_990 })]),
      undefined,
      [contract],
    )
    expect(result.qualifies).toBe(false)
    expect(result.runPassed).toBe(true)
    expect(result.scenarios[0]?.failures.some((failure) => failure.kind === "performance")).toBe(true)
    expect(renderReplicaBenchmarkReport(
      artifact("baseline", [sample({ interactiveCoherentAtMs: 2_000, localDurableAtMs: 1_990 })]),
      undefined,
      [contract],
    )).toMatch(/BASELINE RECORDED/)
  })

  it("requires both the absolute target and at least a ten-times baseline gain", () => {
    const baseline = artifact("baseline", [sample({ interactiveCoherentAtMs: 1_400, localDurableAtMs: 1_390 })])
    const tooSlow = analyzeReplicaBenchmark(
      artifact("gate", [sample({ interactiveCoherentAtMs: 1_045, localDurableAtMs: 1_040 })]),
      baseline,
      [contract],
    )
    expect(tooSlow.runPassed).toBe(false)
    expect(tooSlow.scenarios[0]?.failures.map((failure) => failure.message).join(" "))
      .toMatch(/ratio/)

    const passing = analyzeReplicaBenchmark(
      artifact("gate", [sample({ interactiveCoherentAtMs: 1_039, localDurableAtMs: 1_035 })]),
      baseline,
      [contract],
    )
    expect(passing.runPassed).toBe(true)
  })

  it("rejects a baseline with fewer complete timings than the scenario contract", () => {
    const strictContract = { ...contract, minSamples: 2 }
    const baseline = artifact("baseline", [
      sample({ iteration: 1, baselineObservedAtMs: 1_500 }),
      sample({ iteration: 2, baselineObservedAtMs: null, localDurableAtMs: null }),
    ])
    const result = analyzeReplicaBenchmark(
      artifact("gate", [sample({ iteration: 1 }), sample({ iteration: 2 })]),
      baseline,
      [strictContract],
    )
    expect(result.runPassed).toBe(false)
    expect(result.scenarios[0]?.failures.map((failure) => failure.message).join(" "))
      .toMatch(/baseline needs 2 complete samples, got 1/)
  })
})

describe("correctness cannot be hidden by a fast paint", () => {
  it("fails missing durable-reopen proof", () => {
    const result = analyzeReplicaBenchmark(
      artifact("gate", [sample({
        proofs: [{ id: "canonical-row-matches", passed: true, evidence: "D1 m1" }],
      })]),
      artifact("baseline", [sample({ interactiveCoherentAtMs: 1_500, localDurableAtMs: 1_490 })]),
      [contract],
    )
    expect(result.runPassed).toBe(false)
    expect(result.scenarios[0]?.failures.map((failure) => failure.message).join(" "))
      .toMatch(/intent-durable/)
  })

  it("allows duplicate transport but rejects duplicate business effects", () => {
    const baseline = artifact("baseline", [sample({ interactiveCoherentAtMs: 1_500, localDurableAtMs: 1_490 })])
    const duplicateTransport = analyzeReplicaBenchmark(
      artifact("gate", [sample({ interactiveCoherentAtMs: 1_040, localDurableAtMs: 1_035, transportDeliveryCount: 4 })]),
      baseline,
      [contract],
    )
    expect(duplicateTransport.runPassed).toBe(true)

    const duplicateEffect = analyzeReplicaBenchmark(
      artifact("gate", [sample({ interactiveCoherentAtMs: 1_040, localDurableAtMs: 1_035, businessEffectCount: 2 })]),
      baseline,
      [contract],
    )
    expect(duplicateEffect.runPassed).toBe(false)
    expect(duplicateEffect.scenarios[0]?.failures.map((failure) => failure.message).join(" "))
      .toMatch(/business effect/)
  })

  it("rejects a local intent with no unique canonical outcome", () => {
    const result = analyzeReplicaBenchmark(
      artifact("gate", [sample({ interactiveCoherentAtMs: 1_040, localDurableAtMs: 1_035, canonicalOutcomeCount: 0 })]),
      artifact("baseline", [sample({ interactiveCoherentAtMs: 1_500, localDurableAtMs: 1_490 })]),
      [contract],
    )
    expect(result.runPassed).toBe(false)
    expect(result.scenarios[0]?.failures.map((failure) => failure.message).join(" "))
      .toMatch(/canonical outcome/)
  })
})

describe("blocking network and comparison integrity", () => {
  it("counts only first-party GET completions before the local anchor", () => {
    const measured = sample({
      interactiveCoherentAtMs: 2_100,
      localDurableAtMs: 2_090,
      requests: [
        {
          requestId: "blocking",
          method: "GET",
          url: "http://localhost/api/community/channels/c/messages",
          resourceType: "fetch",
          firstParty: true,
          networkAccess: true,
          startedAtMs: 1_010,
          endedAtMs: 2_010,
          status: 200,
        },
        {
          requestId: "background",
          method: "GET",
          url: "http://localhost/api/community/channels/c/read-state",
          resourceType: "fetch",
          firstParty: true,
          networkAccess: true,
          startedAtMs: 1_020,
          endedAtMs: 2_500,
          status: 200,
        },
        {
          requestId: "write",
          method: "POST",
          url: "http://localhost/api/community/channels/c/messages",
          resourceType: "fetch",
          firstParty: true,
          networkAccess: true,
          startedAtMs: 1_030,
          endedAtMs: 2_030,
          status: 200,
        },
      ],
    })
    expect(userBlockingGets(measured, contract.anchor).map((request) => request.requestId))
      .toEqual(["blocking"])
  })

  it("classifies baseline requests against legacy completion, not a missing local durable anchor", () => {
    const measured = sample({
      localDurableAtMs: null,
      baselineObservedAtMs: 2_100,
      requests: [{
        requestId: "legacy-blocking",
        method: "GET",
        url: "http://localhost/api/community/channels/c/messages",
        resourceType: "fetch",
        firstParty: true,
        networkAccess: true,
        startedAtMs: 1_010,
        endedAtMs: 2_000,
        status: 200,
      }],
    })
    expect(userBlockingGets(measured, contract.anchor, "baseline")).toHaveLength(1)
    expect(userBlockingGets(measured, contract.anchor, "gate")).toHaveLength(0)
  })

  it("rejects comparison across a different fixture or delay", () => {
    const candidate = artifact("gate")
    const baseline = artifact("baseline", [sample()], {
      fixtureVersion: "other-fixture",
      networkDelayMs: 999,
    })
    expect(artifactCompatibilityFailures(candidate, baseline)).toEqual([
      "fixtureVersion differs",
      "networkDelayMs differs",
    ])
    const result = analyzeReplicaBenchmark(candidate, baseline, [contract])
    expect(result.comparisonCompatible).toBe(false)
    expect(result.runPassed).toBe(false)
  })

  it("rejects comparisons across different scenario selections", () => {
    const candidate = artifact("gate")
    const baseline = artifact("baseline", [sample()], { selectedScenarios: ["j5-draft"] })
    expect(artifactCompatibilityFailures(candidate, baseline)).toEqual(["selectedScenarios differ"])
  })
})
