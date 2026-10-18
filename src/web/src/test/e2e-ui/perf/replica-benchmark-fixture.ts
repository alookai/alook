import type { BrowserContext, CDPSession, Page, Request, Response } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type {
  ReplicaBenchmarkArtifact,
  ReplicaBenchmarkSample,
  ReplicaNetworkEvent,
} from "./replica-benchmark-types"

type MutableNetworkEvent = ReplicaNetworkEvent & {
  responseFromServiceWorker: boolean
}

export function isFirstPartyUrl(rawUrl: string, baseUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

export class ReplicaNetworkProbe {
  private readonly events: MutableNetworkEvent[] = []
  private readonly byRequest = new Map<Request, MutableNetworkEvent>()
  private readonly responseByRequest = new Map<Request, Response>()
  private session: CDPSession | null = null
  private nextId = 1

  private readonly onRequest = (request: Request) => {
    const event: MutableNetworkEvent = {
      requestId: `request-${this.nextId++}`,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      firstParty: isFirstPartyUrl(request.url(), this.baseUrl),
      networkAccess: null,
      startedAtMs: Date.now(),
      endedAtMs: null,
      status: null,
      responseFromServiceWorker: false,
    }
    this.byRequest.set(request, event)
    this.events.push(event)
  }

  private readonly onResponse = (response: Response) => {
    const request = response.request()
    const event = this.byRequest.get(request)
    if (!event) return
    event.status = response.status()
    event.responseFromServiceWorker = response.fromServiceWorker()
    this.responseByRequest.set(request, response)
  }

  private readonly onRequestDone = (request: Request) => {
    const event = this.byRequest.get(request)
    if (!event) return
    event.endedAtMs = Date.now()
    const response = this.responseByRequest.get(request)
    if (response) event.responseFromServiceWorker = response.fromServiceWorker()
  }

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly baseUrl: string,
    private readonly latencyMs = 1_000,
  ) {}

  async start(offline = false) {
    this.page.on("request", this.onRequest)
    this.page.on("response", this.onResponse)
    this.page.on("requestfinished", this.onRequestDone)
    this.page.on("requestfailed", this.onRequestDone)
    this.session = await this.context.newCDPSession(this.page)
    await this.session.send("Network.enable")
    await this.setOffline(offline)
  }

  async setOffline(offline: boolean) {
    if (!this.session) throw new Error("network probe has not started")
    await this.session.send("Network.emulateNetworkConditions", {
      offline,
      latency: offline ? 0 : this.latencyMs,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
      connectionType: offline ? "none" : "other",
    })
  }

  requestsSince(actionAtMs: number): ReplicaNetworkEvent[] {
    return this.events
      .filter((event) => event.startedAtMs >= actionAtMs)
      .map(({ responseFromServiceWorker, ...event }) => ({
        ...event,
        networkAccess: responseFromServiceWorker ? false : event.endedAtMs === null ? null : true,
      }))
  }

  async stop() {
    this.page.off("request", this.onRequest)
    this.page.off("response", this.onResponse)
    this.page.off("requestfinished", this.onRequestDone)
    this.page.off("requestfailed", this.onRequestDone)
    if (this.session) {
      await this.session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      }).catch(() => {})
      await this.session.detach().catch(() => {})
      this.session = null
    }
  }
}

export class ReplicaArtifactWriter {
  readonly artifact: ReplicaBenchmarkArtifact

  constructor(
    artifact: Omit<ReplicaBenchmarkArtifact, "samples">,
    private readonly outputPath: string,
  ) {
    this.artifact = { ...artifact, samples: [] }
  }

  append(sample: ReplicaBenchmarkSample) {
    this.artifact.samples.push(sample)
    this.flush()
  }

  flush() {
    mkdirSync(dirname(this.outputPath), { recursive: true })
    writeFileSync(this.outputPath, JSON.stringify(this.artifact, null, 2))
  }
}

export function emptySample(
  scenario: ReplicaBenchmarkSample["scenario"],
  iteration: number,
  actionAtMs = Date.now(),
): ReplicaBenchmarkSample {
  return {
    scenario,
    iteration,
    actionAtMs,
    interactiveCoherentAtMs: null,
    localDurableAtMs: null,
    baselineObservedAtMs: null,
    canonicalOutcomeAtMs: null,
    requests: [],
    manualRecoveryActions: [],
    proofs: [],
    canonicalOutcomeCount: null,
    businessEffectCount: null,
    transportDeliveryCount: null,
    observationEndedAtMs: actionAtMs,
    productFailure: null,
    harnessError: null,
  }
}
