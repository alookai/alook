export const REPLICA_BENCHMARK_SCHEMA_VERSION = 2
export const REPLICA_BENCHMARK_SERVER_MODE = "opennext-preview:production-build:wrangler-local:auth-dev"

export type ReplicaBenchmarkMode = "baseline" | "gate"
export type ReplicaBenchmarkServerMode = typeof REPLICA_BENCHMARK_SERVER_MODE

export type ReplicaScenarioId =
  | "j0-first-bootstrap"
  | "j1-covered-reopen"
  | "j2-covered-navigation"
  | "j3-history-search"
  | "j4-read-state"
  | "j5-draft"
  | "j6-text-send"
  | "j7-domain-rejection"
  | "j8-gap-reconnect"
  | "j9-multi-client"
  | "j10-revocation"

export type ReplicaMeasurementAnchor = "interactive-coherent" | "durable-coherent"

export interface ReplicaNetworkEvent {
  requestId: string
  method: string
  url: string
  resourceType: string
  firstParty: boolean
  networkAccess: boolean | null
  startedAtMs: number
  endedAtMs: number | null
  status: number | null
}

export interface ReplicaProof {
  id: string
  passed: boolean
  evidence: string
}

export interface ReplicaBenchmarkSample {
  scenario: ReplicaScenarioId
  iteration: number
  actionAtMs: number
  interactiveCoherentAtMs: number | null
  localDurableAtMs: number | null
  baselineObservedAtMs: number | null
  canonicalOutcomeAtMs: number | null
  requests: ReplicaNetworkEvent[]
  manualRecoveryActions: string[]
  proofs: ReplicaProof[]
  canonicalOutcomeCount: number | null
  businessEffectCount: number | null
  transportDeliveryCount: number | null
  observationEndedAtMs: number
  productFailure: string | null
  harnessError: string | null
}

export interface ReplicaBenchmarkArtifact {
  schemaVersion: typeof REPLICA_BENCHMARK_SCHEMA_VERSION
  contractVersion: string
  fixtureVersion: string
  selectedScenarios: ReplicaScenarioId[]
  createdAt: string
  gitSha: string
  mode: ReplicaBenchmarkMode
  serverMode: ReplicaBenchmarkServerMode
  networkDelayMs: number
  samples: ReplicaBenchmarkSample[]
}

export interface ReplicaScenarioContract {
  id: ReplicaScenarioId
  label: string
  anchor: ReplicaMeasurementAnchor | null
  absoluteMaxMs: number | null
  maxBaselineRatio: number | null
  minSamples: number
  requiredProofs: string[]
  requireCanonicalOutcome: boolean
  requireSingleBusinessEffect: boolean
  requireZeroBlockingGets: boolean
}

export const REPLICA_SCENARIO_CONTRACTS: readonly ReplicaScenarioContract[] = [
  {
    id: "j0-first-bootstrap",
    label: "J0 First bootstrap",
    anchor: null,
    absoluteMaxMs: null,
    maxBaselineRatio: null,
    minSamples: 1,
    requiredProofs: ["bootstrap-honest", "versions-compatible", "no-half-world"],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: false,
  },
  {
    id: "j1-covered-reopen",
    label: "J1 Covered app reopen",
    anchor: "interactive-coherent",
    absoluteMaxMs: 100,
    maxBaselineRatio: 0.1,
    minSamples: 5,
    requiredProofs: ["covered-world-visible", "transaction-consistent"],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j2-covered-navigation",
    label: "J2 Covered channel/thread navigation",
    anchor: "interactive-coherent",
    absoluteMaxMs: 50,
    maxBaselineRatio: 0.1,
    minSamples: 5,
    requiredProofs: [
      "target-tail-visible",
      "latest-navigation-wins",
      "ordering-correct",
      "read-state-correct",
      "route-correct",
      "surface-kind-correct",
    ],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j3-history-search",
    label: "J3 Covered history, back, and search",
    anchor: "interactive-coherent",
    absoluteMaxMs: 50,
    maxBaselineRatio: 0.1,
    minSamples: 5,
    requiredProofs: [
      "covered-result-complete",
      "coverage-miss-not-empty",
      "pagination-correct",
      "visual-anchor-stable",
    ],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j4-read-state",
    label: "J4 Read state",
    anchor: "durable-coherent",
    absoluteMaxMs: 50,
    maxBaselineRatio: 0.1,
    minSamples: 3,
    requiredProofs: [
      "read-durable",
      "watermark-monotonic",
      "mark-all-boundary-correct",
      "attention-domains-preserved",
    ],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j5-draft",
    label: "J5 Draft survives offline reopen",
    anchor: "interactive-coherent",
    absoluteMaxMs: 100,
    maxBaselineRatio: 0.1,
    minSamples: 3,
    requiredProofs: ["draft-durable", "draft-scope-isolated", "no-server-message-before-send"],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j6-text-send",
    label: "J6 Text send survives offline reopen",
    anchor: "durable-coherent",
    absoluteMaxMs: 50,
    maxBaselineRatio: 0.1,
    minSamples: 3,
    requiredProofs: ["intent-durable", "canonical-row-matches", "read-state-correct"],
    requireCanonicalOutcome: true,
    requireSingleBusinessEffect: true,
    requireZeroBlockingGets: true,
  },
  {
    id: "j7-domain-rejection",
    label: "J7 Domain rejection",
    anchor: "durable-coherent",
    absoluteMaxMs: 50,
    maxBaselineRatio: 0.1,
    minSamples: 3,
    requiredProofs: ["intent-durable", "rejection-explicit", "input-recoverable"],
    requireCanonicalOutcome: true,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: true,
  },
  {
    id: "j8-gap-reconnect",
    label: "J8 Gap and reconnect continuity",
    anchor: null,
    absoluteMaxMs: null,
    maxBaselineRatio: null,
    minSamples: 3,
    requiredProofs: [
      "gap-repaired",
      "duplicate-delivery-idempotent",
      "compatible-frontier",
      "realtime-correct",
      "delta-cost-proportional",
    ],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: true,
    requireZeroBlockingGets: false,
  },
  {
    id: "j9-multi-client",
    label: "J9 Multi-client convergence",
    anchor: null,
    absoluteMaxMs: null,
    maxBaselineRatio: null,
    minSamples: 3,
    requiredProofs: [
      "canonical-order-unique",
      "single-intent-outcome",
      "read-watermark-monotonic",
      "compatible-frontier",
    ],
    requireCanonicalOutcome: true,
    requireSingleBusinessEffect: true,
    requireZeroBlockingGets: false,
  },
  {
    id: "j10-revocation",
    label: "J10 Permission revocation",
    anchor: null,
    absoluteMaxMs: null,
    maxBaselineRatio: null,
    minSamples: 3,
    requiredProofs: [
      "revoked-projection-removed",
      "fallback-accessible",
      "audience-semantics-preserved",
      "existence-masked",
    ],
    requireCanonicalOutcome: false,
    requireSingleBusinessEffect: false,
    requireZeroBlockingGets: false,
  },
] as const
