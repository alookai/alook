import { configuredLimits, type Settings } from "./config"
import { owns, ProviderError, type Provider } from "./cloudflare"
import { PageError, type Artifact, type PageLimits } from "./contracts"
import { availablePrefix } from "./prefix"
import { Registry } from "./registry"
import type { PageRow } from "./schema"

export type Probe = (target: string, prefix: string, limits: PageLimits) => Promise<void>

export class PageService {
  constructor(private readonly registry: Registry, private readonly provider: Provider, private readonly config: Settings, private readonly probe: Probe) {}

  view(row: PageRow) {
    return {
      id: row.id, prefix: row.prefix, state: row.phase,
      url: row.active && row.phase !== "deleting" ? `https://${row.prefix}.${this.config.domain}` : null,
      activeRelease: row.active ? { script: row.active.target, operationId: row.active.operationId, artifactDigest: row.active.digest } : null,
      revision: row.revision, limits: row.limits,
      operation: { id: row.operation.operationId, kind: row.operation.kind, stage: row.stage, pending: row.currentOp !== null, putAcknowledged: row.operation.putAcknowledged === true, error: row.error },
      cleanupPending: row.releases.filter(release => release.target !== row.active?.target).length,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }
  }

  async get(id: string) { return this.view(await this.registry.get(id)) }

  async create(artifact: Artifact) {
    if (!artifact.manifest.prefix) throw new PageError("prefix_required")
    const prefix = availablePrefix(artifact.manifest.prefix, this.config)
    const row = await this.registry.create(prefix, artifact.digest, this.config.limits)
    return this.view(await this.publish(row, artifact))
  }

  async update(id: string, artifact: Artifact) {
    if (artifact.manifest.prefix !== undefined) throw new PageError("prefix_immutable")
    const row = await this.registry.claim(id, "publish", artifact.digest)
    return this.view(await this.publish(row, artifact))
  }

  async configure(id: string, input: unknown) {
    const limits = configuredLimits(input, this.config.limits)
    const row = await this.registry.get(id)
    if (row.currentOp || row.phase === "deleting") throw new PageError("operation_in_progress", 409)
    const updated = await this.registry.patch(row, { limits })
    if (!updated) throw new PageError("operation_in_progress", 409)
    return this.view(updated)
  }

  private async publish(initial: PageRow, artifact: Artifact): Promise<PageRow> {
    const op = initial.operation
    const claimed = await this.registry.patch(initial, { stage: "preflight" })
    if (!claimed) return this.registry.get(initial.id)
    let putStarted = false
    let putCompleted = false
    try {
      const existing = await this.provider.inspect(op.target)
      if (existing) {
        return this.registry.forOperation(initial.id, op.operationId, row => ({
          phase: row.active ? "ready" : "failed", currentOp: null, stage: null, error: "foreign_target",
          releases: row.releases.filter(release => release.target !== op.target),
        }))
      }
      const prepared = await this.registry.forOperation(initial.id, op.operationId, row => row.stage === "preflight" ? { stage: "assets" } : undefined)
      if (prepared.currentOp !== op.operationId || prepared.stage !== "assets") return prepared
      const jwt = await this.provider.assets(op.target, artifact)
      const publishing = await this.registry.forOperation(initial.id, op.operationId, row => row.stage === "assets" ? { stage: "publishing" } : undefined)
      if (publishing.currentOp !== op.operationId || publishing.stage !== "publishing") return publishing
      putStarted = true
      await this.provider.publish(op.target, artifact, op, initial.id, jwt)
      putCompleted = true
      await this.registry.forOperation(initial.id, op.operationId, row => ({ operation: { ...row.operation, putAcknowledged: true } }))
      return await this.confirm(initial.id, op.operationId)
    } catch (error) {
      const uncertain = putCompleted || (putStarted && (!(error instanceof ProviderError) || error.uncertain))
      return this.registry.forOperation(initial.id, op.operationId, row => {
        if (row.stage === "cleanup") return undefined
        const code = error instanceof PageError ? error.code : "publication_error"
        return uncertain
          ? { stage: "uncertain", error: code, ...(putCompleted ? { operation: { ...row.operation, putAcknowledged: true } } : {}) }
          : { phase: row.active ? "ready" : "failed", currentOp: null, stage: null, error: code }
      })
    }
  }

  private async confirm(id: string, opId: string): Promise<PageRow> {
    const row = await this.registry.get(id)
    if (row.currentOp !== opId || !["publishing", "uncertain", "confirming", "blocked"].includes(row.stage ?? "")) return row
    const op = row.operation
    const script = await this.provider.inspect(op.target)
    if (!script) return this.registry.forOperation(id, opId, current => current.stage !== "cleanup" ? { stage: "uncertain", error: "publication_unconfirmed" } : undefined)
    if (!owns(script, id, op)) return this.registry.forOperation(id, opId, current => current.stage !== "cleanup" ? { stage: "blocked", error: "ownership_mismatch" } : undefined)
    const confirming = await this.registry.forOperation(id, opId, current => ["publishing", "uncertain", "confirming", "blocked"].includes(current.stage ?? "") ? { stage: "confirming" } : undefined)
    if (confirming.currentOp !== opId || confirming.stage !== "confirming") return confirming
    try {
      await this.probe(op.target, row.prefix, row.limits)
    } catch {
      return this.registry.forOperation(id, opId, current => {
        if (current.stage !== "confirming") return undefined
        return current.operation.putAcknowledged === true
          ? { phase: current.active ? "ready" : "failed", currentOp: null, stage: null, error: "application_probe_failed" }
          : { stage: "uncertain", error: "publication_probe_unconfirmed" }
      })
    }
    const active = await this.registry.forOperation(id, opId, current => current.stage === "confirming" ? { phase: "ready", active: current.operation, stage: "cleanup", error: null } : undefined)
    if (active.currentOp !== opId || active.stage !== "cleanup") return active
    return await this.cleanup(active) ?? active
  }

  async destroy(id: string) {
    const row = await this.registry.claim(id, "delete")
    return this.cleanupResult(await this.cleanup(row), id)
  }

  async recover(id: string) {
    let row = await this.registry.get(id)
    if (!row.currentOp) {
      if (!row.releases.some(release => release.target !== row.active?.target)) return this.view(row)
      row = await this.registry.claim(id, "cleanup")
    }
    if (row.stage === "deleting" || row.stage === "cleanup") return this.cleanupResult(await this.cleanup(row), id)
    if (row.stage === "reserved" || row.stage === "preflight" || row.stage === "assets") {
      return this.view(await this.registry.forOperation(id, row.operation.operationId, current =>
        ["reserved", "preflight", "assets"].includes(current.stage ?? "")
          ? { phase: current.active ? "ready" : "failed", currentOp: null, stage: null, error: "publication_input_required" } : undefined))
    }
    try {
      return this.view(await this.confirm(id, row.operation.operationId))
    } catch (error) {
      return this.view(await this.registry.forOperation(id, row.operation.operationId, () => ({ error: error instanceof PageError ? error.code : "recovery_error" })))
    }
  }

  private cleanupResult(row: PageRow | null, id: string) { return row ? this.view(row) : { id, state: "deleted" as const } }

  private async cleanup(initial: PageRow): Promise<PageRow | null> {
    const opId = initial.operation.operationId
    const deleting = initial.phase === "deleting"
    let row = initial
    const targets = row.releases.filter(release => deleting || release.target !== row.active?.target).slice(0, 16)
    for (const release of targets) {
      if (row.currentOp !== opId) return row
      try {
        const script = await this.provider.inspect(release.target)
        if (script) {
          if (!owns(script, row.id, release)) throw new PageError("ownership_mismatch", 409)
          await this.provider.destroy(release.target)
          if (await this.provider.inspect(release.target)) throw new PageError("deletion_unconfirmed", 502)
        }
        row = await this.registry.forOperation(row.id, opId, current => ({ releases: current.releases.filter(value => value.target !== release.target) }))
      } catch (error) {
        return this.registry.forOperation(row.id, opId, () => ({
          currentOp: deleting ? opId : null,
          stage: deleting ? "deleting" : null,
          error: error instanceof PageError ? error.code : "cleanup_error",
        }))
      }
    }
    if (deleting && row.releases.length === 0) {
      if (await this.registry.remove(row)) return null
      return this.registry.get(row.id)
    }
    if (deleting) return row
    return this.registry.forOperation(row.id, opId, current => ({
      currentOp: null, stage: null,
      error: current.releases.some(release => release.target !== current.active?.target) ? "cleanup_pending" : null,
    }))
  }
}
