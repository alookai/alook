import { readFileSync, writeFileSync } from "node:fs"
import {
  REPLICA_BENCHMARK_SCHEMA_VERSION,
  REPLICA_BENCHMARK_SERVER_MODE,
  REPLICA_SCENARIO_CONTRACTS,
  type ReplicaBenchmarkArtifact,
  type ReplicaBenchmarkSample,
  type ReplicaMeasurementAnchor,
  type ReplicaScenarioContract,
} from "../src/test/e2e-ui/perf/replica-benchmark-types"

export type ReplicaFailureKind = "harness" | "performance" | "correctness" | "comparison"

export interface ReplicaBenchmarkFailure {
  kind: ReplicaFailureKind
  sampleIteration: number | null
  message: string
}

export interface ReplicaScenarioAnalysis {
  id: string
  label: string
  sampleCount: number
  completeSampleCount: number
  p50Ms: number | null
  p95Ms: number | null
  baselineP95Ms: number | null
  baselineRatio: number | null
  blockingGetCount: number
  manualRecoveryCount: number
  failures: ReplicaBenchmarkFailure[]
  qualifies: boolean
}

export interface ReplicaBenchmarkAnalysis {
  mode: ReplicaBenchmarkArtifact["mode"]
  artifactValid: boolean
  comparisonCompatible: boolean
  qualifies: boolean
  runPassed: boolean
  artifactFailures: ReplicaBenchmarkFailure[]
  scenarios: ReplicaScenarioAnalysis[]
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null
  if (!finiteNumber(quantile) || quantile < 0 || quantile > 1) {
    throw new Error(`quantile must be between 0 and 1, got ${String(quantile)}`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(quantile * sorted.length))
  return sorted[rank - 1] ?? null
}

function anchorAt(sample: ReplicaBenchmarkSample, anchor: ReplicaMeasurementAnchor): number | null {
  if (anchor === "interactive-coherent") return sample.interactiveCoherentAtMs
  if (!finiteNumber(sample.localDurableAtMs) || !finiteNumber(sample.interactiveCoherentAtMs)) {
    return null
  }
  return Math.max(sample.localDurableAtMs, sample.interactiveCoherentAtMs)
}

function observedAt(
  sample: ReplicaBenchmarkSample,
  anchor: ReplicaMeasurementAnchor,
  mode: ReplicaBenchmarkArtifact["mode"],
): number | null {
  return mode === "baseline" && finiteNumber(sample.baselineObservedAtMs)
    ? sample.baselineObservedAtMs
    : anchorAt(sample, anchor)
}

export function sampleLatency(
  sample: ReplicaBenchmarkSample,
  anchor: ReplicaMeasurementAnchor,
  mode: ReplicaBenchmarkArtifact["mode"] = "gate",
): number | null {
  const end = observedAt(sample, anchor, mode)
  if (!finiteNumber(end) || !finiteNumber(sample.actionAtMs) || end < sample.actionAtMs) return null
  return end - sample.actionAtMs
}

export function userBlockingGets(
  sample: ReplicaBenchmarkSample,
  anchor: ReplicaMeasurementAnchor,
  mode: ReplicaBenchmarkArtifact["mode"] = "gate",
) {
  const end = observedAt(sample, anchor, mode)
  if (!finiteNumber(end)) return []
  return sample.requests.filter((request) => (
    request.firstParty
    && request.networkAccess !== false
    && request.method.toUpperCase() === "GET"
    && finiteNumber(request.endedAtMs)
    && request.startedAtMs >= sample.actionAtMs
    && request.endedAtMs <= end
  ))
}

export function artifactCompatibilityFailures(
  candidate: ReplicaBenchmarkArtifact,
  baseline: ReplicaBenchmarkArtifact,
): string[] {
  const failures: string[] = []
  if (candidate.schemaVersion !== baseline.schemaVersion) failures.push("schemaVersion differs")
  if (candidate.contractVersion !== baseline.contractVersion) failures.push("contractVersion differs")
  if (candidate.fixtureVersion !== baseline.fixtureVersion) failures.push("fixtureVersion differs")
  if (candidate.serverMode !== baseline.serverMode) failures.push("serverMode differs")
  if (candidate.networkDelayMs !== baseline.networkDelayMs) failures.push("networkDelayMs differs")
  if (candidate.selectedScenarios.join(",") !== baseline.selectedScenarios.join(",")) {
    failures.push("selectedScenarios differ")
  }
  return failures
}

function artifactShapeFailures(artifact: ReplicaBenchmarkArtifact): ReplicaBenchmarkFailure[] {
  const failures: ReplicaBenchmarkFailure[] = []
  if (artifact.schemaVersion !== REPLICA_BENCHMARK_SCHEMA_VERSION) {
    failures.push({
      kind: "harness",
      sampleIteration: null,
      message: `unsupported schemaVersion ${String(artifact.schemaVersion)}`,
    })
  }
  if (!artifact.contractVersion) {
    failures.push({ kind: "harness", sampleIteration: null, message: "missing contractVersion" })
  }
  if (!artifact.fixtureVersion) {
    failures.push({ kind: "harness", sampleIteration: null, message: "missing fixtureVersion" })
  }
  if (!artifact.gitSha) {
    failures.push({ kind: "harness", sampleIteration: null, message: "missing gitSha" })
  }
  if (artifact.serverMode !== REPLICA_BENCHMARK_SERVER_MODE) {
    failures.push({
      kind: "harness",
      sampleIteration: null,
      message: `serverMode must be ${REPLICA_BENCHMARK_SERVER_MODE}, got ${String(artifact.serverMode)}`,
    })
  }
  if (!Array.isArray(artifact.selectedScenarios) || artifact.selectedScenarios.length === 0) {
    failures.push({ kind: "harness", sampleIteration: null, message: "no selectedScenarios" })
  }
  const knownScenarioIds = new Set(REPLICA_SCENARIO_CONTRACTS.map((contract) => contract.id))
  const unknownScenarioIds = artifact.selectedScenarios.filter((id) => !knownScenarioIds.has(id))
  if (unknownScenarioIds.length > 0) {
    failures.push({
      kind: "harness",
      sampleIteration: null,
      message: `unknown selectedScenarios: ${unknownScenarioIds.join(", ")}`,
    })
  }
  if (artifact.networkDelayMs !== 1_000) {
    failures.push({
      kind: "harness",
      sampleIteration: null,
      message: `networkDelayMs must be 1000, got ${String(artifact.networkDelayMs)}`,
    })
  }
  return failures
}

function correctnessFailures(
  sample: ReplicaBenchmarkSample,
  contract: ReplicaScenarioContract,
): ReplicaBenchmarkFailure[] {
  const failures: ReplicaBenchmarkFailure[] = []
  if (sample.harnessError) {
    failures.push({ kind: "harness", sampleIteration: sample.iteration, message: sample.harnessError })
  }
  if (sample.productFailure) {
    failures.push({ kind: "correctness", sampleIteration: sample.iteration, message: sample.productFailure })
  }
  const proofById = new Map(sample.proofs.map((proof) => [proof.id, proof]))
  for (const proofId of contract.requiredProofs) {
    const proof = proofById.get(proofId)
    if (!proof?.passed) {
      failures.push({
        kind: "correctness",
        sampleIteration: sample.iteration,
        message: `required proof failed or missing: ${proofId}`,
      })
    }
  }
  if (sample.manualRecoveryActions.length > 0) {
    failures.push({
      kind: "correctness",
      sampleIteration: sample.iteration,
      message: `manual recovery required: ${sample.manualRecoveryActions.join(", ")}`,
    })
  }
  if (contract.requireCanonicalOutcome && sample.canonicalOutcomeCount !== 1) {
    failures.push({
      kind: "correctness",
      sampleIteration: sample.iteration,
      message: `expected exactly one canonical outcome, got ${String(sample.canonicalOutcomeCount)}`,
    })
  }
  if (contract.requireSingleBusinessEffect && sample.businessEffectCount !== 1) {
    failures.push({
      kind: "correctness",
      sampleIteration: sample.iteration,
      message: `expected exactly one business effect, got ${String(sample.businessEffectCount)}`,
    })
  }
  return failures
}

export function analyzeScenario(
  artifact: ReplicaBenchmarkArtifact,
  contract: ReplicaScenarioContract,
  baseline?: ReplicaBenchmarkArtifact,
): ReplicaScenarioAnalysis {
  const samples = artifact.samples.filter((sample) => sample.scenario === contract.id)
  const failures: ReplicaBenchmarkFailure[] = []
  const latencies: number[] = []
  let blockingGetCount = 0
  let manualRecoveryCount = 0

  if (samples.length < contract.minSamples) {
    failures.push({
      kind: "harness",
      sampleIteration: null,
      message: `need ${contract.minSamples} samples, got ${samples.length}`,
    })
  }

  for (const sample of samples) {
    if (contract.anchor !== null) {
      const latency = sampleLatency(sample, contract.anchor, artifact.mode)
      if (latency === null) {
        failures.push({
          kind: sample.productFailure ? "performance" : "harness",
          sampleIteration: sample.iteration,
          message: `missing or invalid ${contract.anchor} latency`,
        })
      } else {
        latencies.push(latency)
      }
      const blocking = userBlockingGets(sample, contract.anchor, artifact.mode)
      blockingGetCount += blocking.length
      if (contract.requireZeroBlockingGets && blocking.length > 0) {
        failures.push({
          kind: "performance",
          sampleIteration: sample.iteration,
          message: `${blocking.length} first-party GET(s) completed before local readiness`,
        })
      }
    }
    manualRecoveryCount += sample.manualRecoveryActions.length
    failures.push(...correctnessFailures(sample, contract))
  }

  const p50Ms = percentile(latencies, 0.5)
  const p95Ms = percentile(latencies, 0.95)
  if (contract.absoluteMaxMs !== null && (p95Ms === null || p95Ms >= contract.absoluteMaxMs)) {
    failures.push({
      kind: "performance",
      sampleIteration: null,
      message: `p95 must be <${contract.absoluteMaxMs}ms, got ${String(p95Ms)}`,
    })
  }

  let baselineP95Ms: number | null = null
  let baselineRatio: number | null = null
  if (artifact.mode === "gate" && contract.maxBaselineRatio !== null) {
    if (!baseline) {
      failures.push({ kind: "comparison", sampleIteration: null, message: "missing baseline artifact" })
    } else {
      const baselineLatencies = baseline.samples
        .filter((sample) => sample.scenario === contract.id)
        .map((sample) => contract.anchor === null ? null : sampleLatency(sample, contract.anchor, "baseline"))
        .filter((latency): latency is number => latency !== null)
      baselineP95Ms = percentile(baselineLatencies, 0.95)
      if (baselineLatencies.length < contract.minSamples) {
        failures.push({
          kind: "comparison",
          sampleIteration: null,
          message: `baseline needs ${contract.minSamples} complete samples, got ${baselineLatencies.length}`,
        })
      } else if (baselineP95Ms === null || baselineP95Ms <= 0 || p95Ms === null) {
        failures.push({
          kind: "comparison",
          sampleIteration: null,
          message: "baseline has no valid positive p95",
        })
      } else {
        baselineRatio = p95Ms / baselineP95Ms
        if (baselineRatio > contract.maxBaselineRatio) {
          failures.push({
            kind: "performance",
            sampleIteration: null,
            message: `p95 ratio must be <=${contract.maxBaselineRatio}, got ${baselineRatio.toFixed(3)}`,
          })
        }
      }
    }
  }

  return {
    id: contract.id,
    label: contract.label,
    sampleCount: samples.length,
    completeSampleCount: latencies.length,
    p50Ms,
    p95Ms,
    baselineP95Ms,
    baselineRatio,
    blockingGetCount,
    manualRecoveryCount,
    failures,
    qualifies: failures.length === 0,
  }
}

export function analyzeReplicaBenchmark(
  artifact: ReplicaBenchmarkArtifact,
  baseline?: ReplicaBenchmarkArtifact,
  contracts: readonly ReplicaScenarioContract[] = REPLICA_SCENARIO_CONTRACTS,
): ReplicaBenchmarkAnalysis {
  const artifactFailures = artifactShapeFailures(artifact)
  const selected = new Set(artifact.selectedScenarios)
  const selectedContracts = contracts.filter((contract) => selected.has(contract.id))
  let comparisonCompatible = true
  if (artifact.mode === "gate" && baseline) {
    const compatibility = artifactCompatibilityFailures(artifact, baseline)
    comparisonCompatible = compatibility.length === 0
    artifactFailures.push(...compatibility.map((message) => ({
      kind: "comparison" as const,
      sampleIteration: null,
      message,
    })))
  }
  const scenarios = selectedContracts.map((contract) => analyzeScenario(artifact, contract, baseline))
  const qualifies = artifactFailures.length === 0 && scenarios.every((scenario) => scenario.qualifies)
  const artifactValid = artifactFailures.every((failure) => failure.kind !== "harness")
    && scenarios.every((scenario) => scenario.failures.every((failure) => failure.kind !== "harness"))
  return {
    mode: artifact.mode,
    artifactValid,
    comparisonCompatible,
    qualifies,
    runPassed: artifact.mode === "baseline" ? artifactValid : qualifies,
    artifactFailures,
    scenarios,
  }
}

function metric(value: number | null, suffix = "ms") {
  return value === null ? "—" : `${value.toFixed(1)}${suffix}`
}

export function renderReplicaBenchmarkReport(
  artifact: ReplicaBenchmarkArtifact,
  baseline?: ReplicaBenchmarkArtifact,
  contracts: readonly ReplicaScenarioContract[] = REPLICA_SCENARIO_CONTRACTS,
): string {
  const analysis = analyzeReplicaBenchmark(artifact, baseline, contracts)
  const verdict = artifact.mode === "baseline"
    ? analysis.runPassed ? "BASELINE RECORDED" : "INVALID BASELINE"
    : analysis.runPassed ? "PASS" : "FAIL"
  const lines = [
    "# Alook Replica Benchmark",
    "",
    `Verdict: **${verdict}**`,
    `Candidate: \`${artifact.gitSha}\``,
    `Mode: \`${artifact.mode}\``,
    `Server mode: \`${artifact.serverMode}\``,
    `Network injection: \`${artifact.networkDelayMs}ms\``,
    `Contract / fixture: \`${artifact.contractVersion}\` / \`${artifact.fixtureVersion}\``,
    `Selected scenarios: \`${artifact.selectedScenarios.join(", ")}\``,
    "",
    "| Scenario | n | p50 | p95 | baseline p95 | ratio | blocking GET | manual recovery | qualifies |",
    "|---|---:|---:|---:|---:|---:|---:|---:|:---:|",
  ]
  for (const scenario of analysis.scenarios) {
    lines.push(
      `| ${scenario.label} | ${scenario.completeSampleCount}/${scenario.sampleCount} | `
      + `${metric(scenario.p50Ms)} | ${metric(scenario.p95Ms)} | ${metric(scenario.baselineP95Ms)} | `
      + `${scenario.baselineRatio === null ? "—" : scenario.baselineRatio.toFixed(3)} | `
      + `${scenario.blockingGetCount} | ${scenario.manualRecoveryCount} | ${scenario.qualifies ? "yes" : "no"} |`,
    )
  }
  const failures = [
    ...analysis.artifactFailures,
    ...analysis.scenarios.flatMap((scenario) => scenario.failures.map((failure) => ({
      ...failure,
      message: `${scenario.id}: ${failure.message}`,
    }))),
  ]
  if (failures.length > 0) {
    lines.push("", "## Failures", "")
    for (const failure of failures) {
      const iteration = failure.sampleIteration === null ? "" : ` sample ${failure.sampleIteration}`
      lines.push(`- [${failure.kind}]${iteration}: ${failure.message}`)
    }
  }
  return lines.join("\n")
}

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
  const candidatePath = argValue("--candidate")
  const outputPath = argValue("--out")
  const baselinePath = argValue("--baseline")
  if (!candidatePath || !outputPath) {
    throw new Error("usage: tsx replica-benchmark-report.ts --candidate <json> [--baseline <json>] --out <md>")
  }
  const artifact = JSON.parse(readFileSync(candidatePath, "utf8")) as ReplicaBenchmarkArtifact
  const baseline = baselinePath
    ? JSON.parse(readFileSync(baselinePath, "utf8")) as ReplicaBenchmarkArtifact
    : undefined
  const report = renderReplicaBenchmarkReport(artifact, baseline)
  writeFileSync(outputPath, report)
  const analysis = analyzeReplicaBenchmark(artifact, baseline)
  if (!analysis.runPassed) process.exitCode = 1
}

if (process.argv[1]?.endsWith("replica-benchmark-report.ts")) main()
