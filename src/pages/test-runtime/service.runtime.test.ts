import { env, exports } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/d1"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ownership, ProviderError, type NativeScript, type Provider } from "../src/cloudflare"
import type { Artifact, Release } from "../src/contracts"
import { Registry } from "../src/registry"
import { pages } from "../src/schema"
import { PageService } from "../src/service"
import { artifact, config, upload } from "./fixtures"

class MemoryProvider implements Provider {
  scripts = new Map<string, NativeScript>()
  inspect = vi.fn(async (target: string) => this.scripts.get(target) ?? null)
  assets = vi.fn(async (_target: string, _artifact: Artifact): Promise<string | undefined> => undefined)
  publish = vi.fn(async (target: string, _artifact: Artifact, release: Release, id: string) => { this.scripts.set(target, { tags: ownership(id, release) }) })
  destroy = vi.fn(async (target: string) => { this.scripts.delete(target) })
}

const registry = () => new Registry(env.REGISTRY, config.namespace, config.account)
function setup(provider = new MemoryProvider()) {
  const probe = vi.fn(async (_target: string, _prefix: string) => {})
  return { provider, probe, service: new PageService(registry(), provider, config, probe) }
}

function gate() {
  let release!: () => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
  return { promise, release, fail }
}

beforeEach(async () => { await drizzle(env.REGISTRY).delete(pages) })

describe("native D1 authority and lifecycle", () => {
  it("atomically reserves one canonical prefix before any provider call", async () => {
    const { service, provider } = setup()
    const [a, b] = await Promise.all([artifact("SAME"), artifact("same")])
    const results = await Promise.allSettled([service.create(a), service.create(b)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "prefix_occupied" } }])
    expect(provider.publish).toHaveBeenCalledTimes(1)
    expect((await drizzle(env.REGISTRY).select().from(pages))).toHaveLength(1)
  })
  it("shares prefix authority across namespaces while scoping all management", async () => {
    const first = await registry().create("shared", "digest", config.limits)
    const other = new Registry(env.REGISTRY, "another-namespace", config.account)
    await expect(other.create("shared", "digest", config.limits)).rejects.toMatchObject({ code: "prefix_occupied" })
    await expect(other.get(first.id)).rejects.toMatchObject({ code: "page_not_found" })
    expect(await other.byPrefix("shared")).toBeUndefined()
    expect(await other.patch(first, { error: "wrong" })).toBeUndefined()
    expect(await other.remove(first)).toBe(false)
    const otherAccount = new Registry(env.REGISTRY, config.namespace, "f".repeat(32))
    await expect(otherAccount.create("shared", "digest", config.limits)).rejects.toMatchObject({ code: "prefix_occupied" })
    await expect(otherAccount.get(first.id)).rejects.toMatchObject({ code: "page_not_found" })
    expect(await otherAccount.byPrefix("shared")).toBeUndefined()
    expect(await otherAccount.patch(first, { error: "wrong-account" })).toBeUndefined()
    expect(await otherAccount.remove(first)).toBe(false)
  })
  it("does not misreport unrelated database constraints as a duplicate prefix", async () => {
    const repeated = crypto.randomUUID()
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(repeated)
    try {
      await registry().create("first-id", "d", config.limits)
      await expect(registry().create("another-prefix", "d", config.limits)).rejects.not.toMatchObject({ code: "prefix_occupied" })
      expect(await registry().byPrefix("another-prefix")).toBeUndefined()
    } finally { uuid.mockRestore() }
  })
  it("publishes, queries, updates immutable targets, lowers limits and deletes", async () => {
    const { service, provider, probe } = setup()
    const created = await service.create(await artifact("hello"))
    expect(created).toMatchObject({ prefix: "hello", state: "ready", url: "https://hello.alook.page", operation: { pending: false, stage: null } })
    expect(await service.get(created.id)).toEqual(created)
    const old = (await registry().get(created.id)).active!
    expect(probe).toHaveBeenCalledWith(old.target, "hello", config.limits)
    const updated = await service.update(created.id, await artifact())
    const next = (await registry().get(created.id)).active!
    expect(next.target).not.toBe(old.target)
    expect(updated.revision).toBe(2)
    expect(provider.scripts.has(old.target)).toBe(false)
    expect((await registry().get(created.id)).releases).toHaveLength(1)
    expect(await service.configure(created.id, { cpuMs: 20, subRequests: 8 })).toMatchObject({ limits: { cpuMs: 20, subRequests: 8 } })
    expect(await service.recover(created.id)).toMatchObject({ state: "ready", operation: { pending: false } })
    expect(await service.destroy(created.id)).toEqual({ id: created.id, state: "deleted" })
    expect(provider.scripts.size).toBe(0)
    await expect(service.get(created.id)).rejects.toMatchObject({ code: "page_not_found" })
    expect(await service.create(await artifact("hello"))).toMatchObject({ state: "ready" })
  })
  it("rejects invalid/reserved create and prefix changes before provider writes", async () => {
    const { service, provider } = setup()
    await expect(service.create(await artifact())).rejects.toMatchObject({ code: "prefix_required" })
    await expect(service.create(await artifact("www"))).rejects.toMatchObject({ code: "reserved_prefix" })
    await expect(service.update("unknown", await artifact("new"))).rejects.toMatchObject({ code: "prefix_immutable" })
    expect(provider.publish).not.toHaveBeenCalled()
    expect(await drizzle(env.REGISTRY).select().from(pages)).toEqual([])
  })
  it("does not overwrite a preexisting unregistered native object", async () => {
    const { service, provider } = setup()
    provider.inspect.mockResolvedValueOnce({ tags: ["foreign"] })
    const result = await service.create(await artifact("foreign"))
    expect(result).toMatchObject({ state: "failed", operation: { pending: false, error: "foreign_target" } })
    expect(provider.publish).not.toHaveBeenCalled()
    expect(await service.destroy(result.id)).toEqual({ id: result.id, state: "deleted" })
    expect(provider.destroy).not.toHaveBeenCalled()
  })
  it("preserves the active release after known failure and allows an explicit new revision", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("stable"))
    const old = (await registry().get(created.id)).active!
    provider.publish.mockRejectedValueOnce(new ProviderError("provider_http_400", false))
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", operation: { pending: false, error: "provider_http_400" } })
    expect((await registry().get(created.id)).active).toEqual(old)
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", revision: 3 })
    expect(provider.publish.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([old.target]))
  })
  it("holds an unknown PUT and404 across restart; late owned publication can recover", async () => {
    const { service, provider } = setup()
    provider.publish.mockRejectedValueOnce(new ProviderError("provider_transport_error", true))
    const created = await service.create(await artifact("uncertain"))
    expect(created).toMatchObject({ state: "publishing", url: null, operation: { pending: true, stage: "uncertain" } })
    const restarted = new PageService(registry(), provider, config, async () => {})
    expect(await restarted.recover(created.id)).toMatchObject({ operation: { pending: true, stage: "uncertain", error: "publication_unconfirmed" } })
    await expect(restarted.create(await artifact("UNCERTAIN"))).rejects.toMatchObject({ code: "prefix_occupied" })
    await expect(restarted.update(created.id, await artifact())).rejects.toMatchObject({ code: "operation_in_progress" })
    await expect(restarted.destroy(created.id)).rejects.toMatchObject({ code: "operation_in_progress" })
    await expect(restarted.configure(created.id, { cpuMs: 10, subRequests: 1 })).rejects.toMatchObject({ code: "operation_in_progress" })
    const row = await registry().get(created.id)
    provider.scripts.set(row.operation.target, { tags: ownership(row.id, row.operation) })
    expect(await restarted.recover(created.id)).toMatchObject({ state: "ready", operation: { pending: false } })
    expect(provider.publish).toHaveBeenCalledTimes(1)
  })
  it("holds publication when metadata confirmation fails after a successful PUT", async () => {
    const { service, provider } = setup()
    provider.inspect.mockResolvedValueOnce(null).mockRejectedValueOnce(new ProviderError("provider_http_503", false))
    const created = await service.create(await artifact("confirmation-read-failure"))
    expect(created).toMatchObject({ state: "publishing", url: null, operation: { pending: true, stage: "uncertain", error: "provider_http_503" } })
    await expect(service.destroy(created.id)).rejects.toMatchObject({ code: "operation_in_progress" })
    provider.inspect.mockResolvedValueOnce(null)
    expect(await service.recover(created.id)).toMatchObject({ operation: { pending: true, stage: "uncertain" } })
    expect(await service.recover(created.id)).toMatchObject({ state: "ready", operation: { pending: false } })
    expect(provider.publish).toHaveBeenCalledTimes(1)
  })
  it("allows repair after an acknowledged publication's application probe throws", async () => {
    const { service, provider, probe } = setup()
    probe.mockRejectedValueOnce(new Error("application exception"))
    const created = await service.create(await artifact("repairable-app"))
    expect(created).toMatchObject({ state: "failed", url: null, operation: { pending: false, putAcknowledged: true, error: "application_probe_failed" } })
    const row = await registry().get(created.id)
    expect(row.operation.putAcknowledged).toBe(true)
    expect(row.releases).toHaveLength(1)
    expect(provider.scripts.has(row.operation.target)).toBe(true)
    const restarted = new PageService(registry(), provider, config, async () => {})
    expect(await restarted.configure(created.id, { cpuMs: 20, subRequests: 3 })).toMatchObject({ state: "failed" })
    expect(await restarted.update(created.id, await artifact())).toMatchObject({ state: "ready", operation: { pending: false } })
    expect(provider.scripts.has(row.operation.target)).toBe(false)
    expect(await restarted.destroy(created.id)).toEqual({ id: created.id, state: "deleted" })
    expect(await restarted.create(await artifact("repairable-app"))).toMatchObject({ state: "ready" })
  })
  it("retains the old active release after an acknowledged update's application exception", async () => {
    const { service, provider, probe } = setup()
    const created = await service.create(await artifact("bad-update"))
    const active = (await registry().get(created.id)).active
    probe.mockRejectedValueOnce(new Error("application exception"))
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", url: created.url, operation: { pending: false, putAcknowledged: true, error: "application_probe_failed" } })
    const row = await registry().get(created.id)
    expect(row.active).toEqual(active)
    expect(row.releases).toHaveLength(2)
    expect(provider.destroy).not.toHaveBeenCalled()
    expect(await service.destroy(created.id)).toEqual({ id: created.id, state: "deleted" })
    expect(provider.scripts.size).toBe(0)
  })
  it("keeps an in-flight PUT busy after owned metadata and a probe exception until its actual receipt", async () => {
    const { service, provider, probe } = setup()
    const started = gate(); const putReceipt = gate()
    provider.publish.mockImplementationOnce(async (target, _artifact, release, id) => {
      provider.scripts.set(target, { tags: ownership(id, release) })
      started.release(); await putReceipt.promise
    })
    probe.mockRejectedValue(new Error("application exception"))
    const pending = service.create(await artifact("inflight-bad-app"))
    await started.promise
    const row = (await registry().byPrefix("inflight-bad-app"))!
    expect(row.operation.putAcknowledged).toBeUndefined()
    const restarted = new PageService(registry(), provider, config, probe)
    expect(await restarted.recover(row.id)).toMatchObject({ state: "publishing", url: null, operation: { pending: true, putAcknowledged: false, stage: "uncertain", error: "publication_probe_unconfirmed" } })
    await expect(restarted.configure(row.id, { cpuMs: 20, subRequests: 3 })).rejects.toMatchObject({ code: "operation_in_progress" })
    await expect(restarted.update(row.id, await artifact())).rejects.toMatchObject({ code: "operation_in_progress" })
    await expect(restarted.destroy(row.id)).rejects.toMatchObject({ code: "operation_in_progress" })
    provider.inspect.mockResolvedValueOnce(null)
    expect(await restarted.recover(row.id)).toMatchObject({ operation: { pending: true, putAcknowledged: false, error: "publication_unconfirmed" } })
    expect((await registry().get(row.id)).operation.putAcknowledged).toBeUndefined()
    putReceipt.release()
    expect(await pending).toMatchObject({ state: "failed", operation: { pending: false, putAcknowledged: true, error: "application_probe_failed" } })
    expect((await registry().get(row.id)).operation.putAcknowledged).toBe(true)
    expect(provider.publish).toHaveBeenCalledTimes(1)
    expect(await restarted.destroy(row.id)).toEqual({ id: row.id, state: "deleted" })
  })
  it("does not invent a PUT acknowledgment after a lost response and repeated owned probe failures", async () => {
    const { service, provider, probe } = setup()
    provider.publish.mockImplementationOnce(async (target, _artifact, release, id) => {
      provider.scripts.set(target, { tags: ownership(id, release) })
      throw new ProviderError("provider_transport_error", true)
    })
    probe.mockRejectedValue(new Error("application exception"))
    const created = await service.create(await artifact("lost-bad-app"))
    for (let restart = 0; restart < 2; restart++) {
      const restarted = new PageService(registry(), provider, config, probe)
      expect(await restarted.recover(created.id)).toMatchObject({ operation: { pending: true, putAcknowledged: false, error: "publication_probe_unconfirmed" } })
      await expect(restarted.destroy(created.id)).rejects.toMatchObject({ code: "operation_in_progress" })
    }
    await expect(service.create(await artifact("lost-bad-app"))).rejects.toMatchObject({ code: "prefix_occupied" })
    expect((await registry().get(created.id)).operation.putAcknowledged).toBeUndefined()
    expect(provider.publish).toHaveBeenCalledTimes(1)
    expect(provider.destroy).not.toHaveBeenCalled()
  })
  it("uses the durable acknowledgment after rebuilding the service and fences a late failed probe", async () => {
    const { service, provider, probe } = setup()
    const started = gate(); const releaseProbe = gate()
    probe.mockImplementationOnce(async () => { started.release(); await releaseProbe.promise })
    const pending = service.create(await artifact("durable-ack"))
    await started.promise
    const row = (await registry().byPrefix("durable-ack"))!
    expect(row.operation.putAcknowledged).toBe(true)
    const restarted = new PageService(registry(), provider, config, async () => { throw new Error("application exception") })
    expect(await restarted.recover(row.id)).toMatchObject({ state: "failed", operation: { pending: false, putAcknowledged: true, error: "application_probe_failed" } })
    const fixed = await service.update(row.id, await artifact())
    expect(fixed.state).toBe("ready")
    releaseProbe.fail(new Error("late failed probe"))
    expect(await pending).toMatchObject({ state: "ready", activeRelease: fixed.activeRelease, operation: { pending: false, error: null } })
    expect((await registry().get(row.id)).active?.target).toBe(fixed.activeRelease?.script)
  })
  it("rejects foreign confirmation and can later reconcile matching durable identity", async () => {
    const { service, provider } = setup()
    provider.publish.mockImplementationOnce(async target => { provider.scripts.set(target, { tags: ["foreign"] }) })
    const created = await service.create(await artifact("ownership"))
    expect(created).toMatchObject({ operation: { pending: true, stage: "blocked", error: "ownership_mismatch" } })
    const row = await registry().get(created.id)
    provider.scripts.set(row.operation.target, { tags: ownership(row.id, row.operation) })
    expect(await service.recover(row.id)).toMatchObject({ state: "ready", operation: { pending: false } })
  })
  it("fences a restarted pre-PUT operation so its late asset response cannot publish", async () => {
    const { service, provider } = setup()
    let releaseAssets!: () => void
    let assetStarted!: () => void
    const started = new Promise<void>(resolve => { assetStarted = resolve })
    const held = new Promise<void>(resolve => { releaseAssets = resolve })
    provider.assets.mockImplementationOnce(async () => { assetStarted(); await held; return undefined })
    const pending = service.create(await artifact("fenced"))
    await started
    const row = await registry().byPrefix("fenced")
    expect(await service.recover(row!.id)).toMatchObject({ state: "failed", operation: { pending: false, error: "publication_input_required" } })
    const newResult = await service.update(row!.id, await artifact())
    releaseAssets()
    expect(await pending).toMatchObject({ id: row!.id, revision: newResult.revision, state: "ready" })
    expect(provider.publish).toHaveBeenCalledTimes(1)
  })
  it("cannot let a late original confirmation replace a newer active revision", async () => {
    const { service, provider } = setup()
    let releasePut!: () => void
    let putStarted!: () => void
    const started = new Promise<void>(resolve => { putStarted = resolve })
    const held = new Promise<void>(resolve => { releasePut = resolve })
    provider.publish.mockImplementationOnce(async (target, _artifact, release, id) => { provider.scripts.set(target, { tags: ownership(id, release) }); putStarted(); await held })
    const pending = service.create(await artifact("late"))
    await started
    const row = (await registry().byPrefix("late"))!
    expect(await service.recover(row.id)).toMatchObject({ state: "ready" })
    await service.update(row.id, await artifact())
    const active = (await registry().get(row.id)).active
    releasePut()
    await pending
    expect((await registry().get(row.id)).active).toEqual(active)
  })
  it("retries safe deletion after failure and keeps the prefix while cleanup is unconfirmed", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("deleting"))
    provider.destroy.mockRejectedValueOnce(new ProviderError("provider_transport_error", true))
    expect(await service.destroy(created.id)).toMatchObject({ state: "deleting", url: null, operation: { pending: true, error: "provider_transport_error" } })
    await expect(service.create(await artifact("deleting"))).rejects.toMatchObject({ code: "prefix_occupied" })
    expect(await service.recover(created.id)).toEqual({ id: created.id, state: "deleted" })
    expect(await service.create(await artifact("deleting"))).toMatchObject({ state: "ready" })
    const targets = provider.publish.mock.calls.map(call => call[0])
    expect(targets[0]).not.toBe(targets[1])
  })
  it("holds deletion for mismatched ownership and a successful DELETE with a remaining object", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("blocked-delete"))
    const row = await registry().get(created.id)
    provider.scripts.set(row.active!.target, { tags: [] })
    expect(await service.destroy(created.id)).toMatchObject({ state: "deleting", operation: { pending: true, error: "ownership_mismatch" } })
    expect(provider.destroy).not.toHaveBeenCalled()
    provider.scripts.set(row.active!.target, { tags: ownership(row.id, row.active!) })
    provider.destroy.mockResolvedValueOnce(undefined)
    expect(await service.recover(created.id)).toMatchObject({ operation: { error: "deletion_unconfirmed" } })
    expect(await service.recover(created.id)).toEqual({ id: created.id, state: "deleted" })
  })
  it("retains old cleanup refs for explicit recovery and bounds each deletion batch", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("cleanup"))
    provider.destroy.mockRejectedValueOnce(new Error("private cleanup detail"))
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", cleanupPending: 1, operation: { pending: false, error: "cleanup_error" } })
    expect(await service.recover(created.id)).toMatchObject({ cleanupPending: 0 })
    const row = await registry().get(created.id)
    const extra = Array.from({ length: 18 }, (_, i) => ({ ...row.active!, target: `old-${i}` }))
    await registry().patch(row, { releases: [...row.releases, ...extra] })
    expect(await service.destroy(created.id)).toMatchObject({ state: "deleting", operation: { pending: true } })
    expect((await registry().get(created.id)).releases).toHaveLength(3)
    expect(await service.recover(created.id)).toEqual({ id: created.id, state: "deleted" })
  })
  it("uses D1 revision CAS, guards stale writers and retains bounded references", async () => {
    const first = await registry().create("cas", "d", config.limits)
    const changed = await registry().patch(first, { error: "new" })
    expect(changed).toBeDefined()
    expect(await registry().patch(first, { error: "stale" })).toBeUndefined()
    expect(await registry().remove(first)).toBe(false)
    expect(await registry().forOperation(first.id, "old-operation", () => ({ error: "wrong" }))).toMatchObject({ error: "new" })
    await registry().forOperation(first.id, first.operation.operationId, () => ({ currentOp: null, stage: null }))
    const current = await registry().get(first.id)
    await registry().patch(current, { releases: Array.from({ length: 64 }, () => first.operation) })
    await expect(registry().claim(first.id, "publish", "d")).rejects.toMatchObject({ code: "cleanup_required" })
  })
  it("reports recovery read failures safely and leaves the unresolved publication occupied", async () => {
    const { service, provider } = setup()
    provider.publish.mockRejectedValueOnce(new ProviderError("provider_transport_error", true))
    const created = await service.create(await artifact("recovery-read"))
    provider.inspect.mockRejectedValueOnce(new ProviderError("provider_http_503", false))
    expect(await service.recover(created.id)).toMatchObject({ operation: { pending: true, error: "provider_http_503" } })
    provider.inspect.mockRejectedValueOnce(new Error("private"))
    expect(await service.recover(created.id)).toMatchObject({ operation: { pending: true, error: "recovery_error" } })
  })
  it("bounds repeated CAS contention and does not lose deletion state on a stale final removal", async () => {
    const store = registry()
    const first = await store.create("contention", "d", config.limits)
    const originalPatch = store.patch.bind(store)
    const blocked = vi.spyOn(store, "patch").mockResolvedValue(undefined)
    await expect(store.forOperation(first.id, first.operation.operationId, () => ({ error: "next" }))).rejects.toMatchObject({ code: "operation_in_progress" })
    expect(blocked).toHaveBeenCalledTimes(4)
    blocked.mockRestore()
    await originalPatch(first, { currentOp: null, releases: [], stage: null })
    const failedRemove = vi.spyOn(store, "remove").mockResolvedValueOnce(false)
    const service = new PageService(store, new MemoryProvider(), config, async () => {})
    expect(await service.destroy(first.id)).toMatchObject({ state: "deleting", operation: { pending: true } })
    failedRemove.mockRestore()
    expect(await service.recover(first.id)).toEqual({ id: first.id, state: "deleted" })
  })
  it("admits only one concurrent mutation or limit configuration", async () => {
    const { service } = setup()
    const created = await service.create(await artifact("mutations"))
    const configured = await Promise.allSettled([
      service.configure(created.id, { cpuMs: 20, subRequests: 1 }),
      service.configure(created.id, { cpuMs: 30, subRequests: 2 }),
    ])
    expect(configured.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "operation_in_progress" } }])
    const claims = await Promise.allSettled([registry().claim(created.id, "publish", "next"), registry().claim(created.id, "delete")])
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(claims.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "operation_in_progress" } }])
    const row = await registry().get(created.id)
    const same = await registry().forOperation(row.id, row.currentOp!, () => undefined)
    expect(same.version).toBe(row.version)
    const deleting = await registry().patch(same, { currentOp: null, phase: "deleting" })
    await expect(registry().claim(deleting!.id, "publish", "d")).rejects.toMatchObject({ code: "page_deleting" })
  })
  it("fences recovery immediately after reservation and during preflight", async () => {
    const store = registry()
    const provider = new MemoryProvider()
    const service = new PageService(store, provider, config, async () => {})
    const originalCreate = store.create.bind(store)
    const reserved = gate(); const resume = gate()
    vi.spyOn(store, "create").mockImplementationOnce(async (...args) => { const row = await originalCreate(...args); reserved.release(); await resume.promise; return row })
    const first = service.create(await artifact("reserve-fence"))
    await reserved.promise
    const row = (await store.byPrefix("reserve-fence"))!
    await service.recover(row.id)
    resume.release()
    expect(await first).toMatchObject({ state: "failed", operation: { pending: false } })
    expect(provider.inspect).not.toHaveBeenCalled()
    const inspected = gate(); const resumeInspect = gate()
    provider.inspect.mockImplementationOnce(async () => { inspected.release(); await resumeInspect.promise; return null })
    const second = service.update(row.id, await artifact())
    await inspected.promise
    await service.recover(row.id)
    resumeInspect.release()
    expect(await second).toMatchObject({ state: "failed", operation: { pending: false } })
    expect(provider.publish).not.toHaveBeenCalled()
  })
  it("keeps an old active release after foreign preflight and stopped asset preparation", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("old-active"))
    const active = (await registry().get(created.id)).active
    provider.inspect.mockResolvedValueOnce({ tags: ["foreign"] })
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", operation: { error: "foreign_target" } })
    const started = gate(); const held = gate()
    provider.assets.mockImplementationOnce(async () => { started.release(); await held.promise; return undefined })
    const pending = service.update(created.id, await artifact())
    await started.promise
    expect(await service.recover(created.id)).toMatchObject({ state: "ready", operation: { pending: false, error: "publication_input_required" } })
    held.release(); await pending
    expect((await registry().get(created.id)).active).toEqual(active)
    provider.assets.mockRejectedValueOnce(new Error("private detail"))
    expect(await service.update(created.id, await artifact())).toMatchObject({ state: "ready", operation: { pending: false, error: "publication_error" } })
    provider.assets.mockRejectedValueOnce(new Error("private detail"))
    expect(await service.create(await artifact("known-create-failure"))).toMatchObject({ state: "failed", operation: { pending: false, error: "publication_error" } })
  })
  it.each(["missing", "foreign", "owned"] as const)("does not regress cleanup after a late %s metadata read", async result => {
    const { service, provider } = setup()
    const created = await service.create(await artifact(`metadata-${result}`))
    const old = (await registry().get(created.id)).active!
    const readStarted = gate(); const releaseRead = gate(); const deleteStarted = gate(); const releaseDelete = gate()
    const inspect = provider.inspect.getMockImplementation()!
    let held = false
    provider.inspect.mockImplementation(async target => {
      if (target !== old.target && !held && provider.scripts.has(target)) {
        held = true; readStarted.release(); await releaseRead.promise
        if (result === "missing") return null
        if (result === "foreign") return { tags: ["foreign"] }
      }
      return inspect(target)
    })
    provider.destroy.mockImplementationOnce(async target => { deleteStarted.release(); await releaseDelete.promise; provider.scripts.delete(target) })
    const pending = service.update(created.id, await artifact())
    await readStarted.promise
    const recovery = service.recover(created.id)
    await deleteStarted.promise
    const activated = (await registry().get(created.id)).active!
    releaseRead.release()
    expect(await pending).toMatchObject({ state: "ready", activeRelease: { script: activated.target }, operation: { error: null } })
    releaseDelete.release()
    expect(await recovery).toMatchObject({ state: "ready", operation: { pending: false } })
  })
  it.each([false, true])("preserves concurrent activation when a late probe rejects=%s", async rejects => {
    const { service, provider, probe } = setup()
    const created = await service.create(await artifact(`probe-${rejects}`))
    const probeStarted = gate(); const releaseProbe = gate(); const deleteStarted = gate(); const releaseDelete = gate()
    probe.mockImplementationOnce(async () => { probeStarted.release(); await releaseProbe.promise })
    provider.destroy.mockImplementationOnce(async target => { deleteStarted.release(); await releaseDelete.promise; provider.scripts.delete(target) })
    const pending = service.update(created.id, await artifact())
    await probeStarted.promise
    const recovery = service.recover(created.id)
    await deleteStarted.promise
    const activated = (await registry().get(created.id)).active!
    if (rejects) releaseProbe.fail(new Error("late probe error")); else releaseProbe.release()
    expect(await pending).toMatchObject({ state: "ready", activeRelease: { script: activated.target }, operation: { error: null } })
    releaseDelete.release()
    expect(await recovery).toMatchObject({ state: "ready", operation: { pending: false } })
  })
  it("stops a stale multi-target cleanup after another recovery finishes", async () => {
    const { service, provider } = setup()
    const created = await service.create(await artifact("stale-cleanup"))
    const oldest = (await registry().get(created.id)).active!
    provider.destroy.mockRejectedValueOnce(new Error("held cleanup"))
    await service.update(created.id, await artifact())
    const readStarted = gate(); const resumeRead = gate()
    const inspect = provider.inspect.getMockImplementation()!
    let held = false
    provider.inspect.mockImplementation(async target => {
      if (target === oldest.target && !held) { held = true; readStarted.release(); await resumeRead.promise }
      return inspect(target)
    })
    const pending = service.update(created.id, await artifact())
    await readStarted.promise
    expect(await service.recover(created.id)).toMatchObject({ state: "ready", cleanupPending: 0, operation: { pending: false } })
    resumeRead.release()
    expect(await pending).toMatchObject({ state: "ready", cleanupPending: 0, operation: { pending: false } })
  })
})

describe("native private entrypoint and public boundary", () => {
  it("calls named entrypoint RPC and returns safe validation/errors", async () => {
    const row = await registry().create("rpc", "digest", config.limits)
    const response = await exports.PageManager.get(row.id)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: row.id, state: "publishing" })
    expect((await exports.PageManager.get("missing")).status).toBe(404)
    expect((await exports.PageManager.create(new Request("https://private/", { method: "POST", body: "{}" }))).status).toBe(400)
    expect(await (await exports.PageManager.update(row.id, upload())).json()).toEqual({ error: "prefix_immutable" })
    expect((await exports.PageManager.configure(row.id, { cpuMs: 1, subRequests: 1 })).status).toBe(409)
    expect((await exports.PageManager.destroy(row.id)).status).toBe(409)
    expect(await (await exports.PageManager.recover(row.id)).json()).toMatchObject({ operation: { pending: false } })
    expect((await exports.PageManager.configure(row.id, { cpuMs: 1, subRequests: 1 })).status).toBe(200)
  })
  it("never selects management through public paths or headers", async () => {
    for (const path of ["/pages", "/rpc/get", "/PageManager/create", "/__admin", "/"]) {
      const response = await exports.default.fetch(new Request(`https://unknown.alook.page${path}`, { method: "POST", headers: { authorization: "Bearer guessed", "x-rpc-method": "create" }, body: "{}" }))
      expect(response.status).toBe(404)
    }
    const row = await registry().create("pending", "digest", config.limits)
    expect((await exports.default.fetch(new Request("https://pending.alook.page/pages"))).status).toBe(503)
    expect((await exports.default.fetch(new Request("https://alook.page/"))).status).toBe(404)
    await registry().forOperation(row.id, row.operation.operationId, () => ({ currentOp: null, active: row.operation, phase: "ready" }))
    expect((await exports.default.fetch(new Request("https://pending.alook.page/"))).status).toBe(502)
  })
})
