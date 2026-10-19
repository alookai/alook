import { expect, test } from "../../_fixtures/case-fixture"
import {
  activateAfterClientExit, attachQa, blocked, createQaPhaseOwner, executingWorkerIdentity,
  expectReleasePrecache, observeCandidate, ownSwFault, ownedBusiness, ownedCdp, ownedOffline,
  publicNativeSnapshot, readNativeResource, releaseAssets, releaseDelta,
  requiredQaManifest, rootStates, rootWorker, runQaScope, updateRoot, withinQaDeadline,
} from "../../_fixtures/public-static-qa"

for (const action of ["404", "offline", "mime", "private", "no-store", "quota"] as const) {
  test(`candidate installation rejects actual ${action} and recovers after that owned fault is removed`, async ({ caseActors, caseResources }, testInfo) => {
    const phase = createQaPhaseOwner(caseResources, testInfo)
    await phase.switchTo("N")
    const actors = await caseActors(["alice"])
    const business = await ownedBusiness(actors, "alice", caseResources)
    const originalMessage = await business.write(`${action} original server message`)
    const connections = business.proxy.connectionCount()
    const context = business.context
    const page = await context.newPage()
    await page.goto("/contact")
    await rootWorker(page)
    const manifest = requiredQaManifest()
    const active = await executingWorkerIdentity(page, caseResources, testInfo, "activated")
    expect(active.sha256).toBe(manifest.releases.N.swSha256)
    const delta = releaseDelta(releaseAssets("N"), releaseAssets("Nplus1"))
    const oldAsset = releaseAssets("N").find(asset => asset.precache && delta.unchanged.includes(asset.url))!
    const before = await readNativeResource(page, oldAsset.url)
    expect(before).toMatchObject({ bytes: oldAsset.bytes, sha256: oldAsset.sha256, fromServiceWorker: true })
    const asset = releaseAssets("Nplus1").find(asset => asset.zone === "main" && asset.precache && delta.added.includes(asset.url) && /\.m?js$/.test(asset.url))
    if (!asset) blocked(testInfo, "This actual pair has no candidate-added public JS precache request")
    const candidate = observeCandidate(context, caseResources)
    let fault: Awaited<ReturnType<typeof ownSwFault>> | undefined
    let quota: { close: () => Promise<void> } | undefined
    let quotaProof: unknown
    if (action === "quota") {
      const cdp = await ownedCdp(caseResources, context, page)
      const origin = new URL(page.url()).origin
      quota = caseResources.own({}, async () => runQaScope(async onClose => {
        onClose(cdp.close)
        await withinQaDeadline(cdp.session.send("Storage.overrideQuotaForOrigin", { origin }), caseResources.deadline)
        const restored = await withinQaDeadline(cdp.session.send("Storage.getUsageAndQuota", { origin }), caseResources.deadline)
        expect(restored.overrideActive).toBe(false)
      }))
      try {
        await withinQaDeadline(cdp.session.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 }), caseResources.deadline)
        const report = await withinQaDeadline(cdp.session.send("Storage.getUsageAndQuota", { origin }), caseResources.deadline)
        expect(report.overrideActive).toBe(true)
        const error = await page.evaluate(async () => {
          const name = "qa-222-quota-control", key = new URL("/qa-222-quota-control", location.href).href
          try { const cache = await caches.open(name); await cache.put(key, new Response(new Uint8Array(4096))); return null }
          catch (error) { return error instanceof DOMException ? error.name : String(error) }
          finally { await caches.delete(name) }
        })
        if (error !== "QuotaExceededError") blocked(testInfo, "Installed Chromium quota override did not produce a native QuotaExceededError")
        quotaProof = { preparation: "artificial origin quota in this case-owned context", ...report, nativeControlError: error }
      } catch (error) {
        if (String(error).includes("BLOCKED")) throw error
        blocked(testInfo, `Installed owned quota primitive unavailable: ${String(error)}`)
      }
    } else fault = await ownSwFault(caseResources, context, new URL(asset.url, page.url()).href, candidate.promise, action, asset)
    await phase.switchTo("Nplus1")
    const update = await updateRoot(page)
    await withinQaDeadline(candidate.promise, caseResources.deadline)
    await expect.poll(async () => (await rootStates(page)).observed).toContain("redundant")
    const failed = await rootStates(page)
    expect(failed.waiting).toBeUndefined()
    expect(failed.active).toBe("activated")
    if (fault) {
      expect(fault.records.length).toBeGreaterThan(0)
      expect(fault.records.every(record => record.completed)).toBe(true)
    }
    if (quota) await quota.close()
    await ownedOffline(caseResources, context, async () => { expect(await readNativeResource(page, oldAsset.url)).toEqual(before) })
    const retained = await executingWorkerIdentity(page, caseResources, testInfo, "activated")
    expect(retained.sha256).toBe(active.sha256)
    expect(retained.versionId).toBe(active.versionId)
    expect(await business.read(originalMessage.id)).toMatchObject({ id: originalMessage.id, seq: originalMessage.seq, content: originalMessage.content })
    const nextMessage = await business.write(`${action} failed candidate retained business connection`)
    expect(nextMessage.seq).toBeGreaterThan(originalMessage.seq)
    expect(business.proxy.connectionCount()).toBe(connections)
    await attachQa(testInfo, `actual-${action}-installation-failure`, { action, asset, update, failed, active, retained, oldResource: before, originalMessage, nextMessage, connections, connectionFrames: business.proxy.connectionFrames, fault: fault?.records, quotaProof, nativeAfterFailure: await publicNativeSnapshot(page) })
    if (fault) await fault.close()
    await candidate.close()
    await updateRoot(page)
    await expect.poll(() => rootStates(page)).toMatchObject({ waiting: "installed", active: "activated" })
    const recoveredWaiting = await executingWorkerIdentity(page, caseResources, testInfo, "installed")
    expect(recoveredWaiting.sha256).toBe(manifest.releases.Nplus1.swSha256)
    const neutral = await activateAfterClientExit(context, caseResources, [page, business.page], recoveredWaiting.versionId, testInfo)
    const recovered = await executingWorkerIdentity(neutral, caseResources, testInfo, "activated")
    expect(recovered.sha256).toBe(manifest.releases.Nplus1.swSha256)
    await expectReleasePrecache(neutral, "Nplus1")
    await attachQa(testInfo, `ordinary-${action}-recovery`, { recovered, forcedActivation: false })
    await phase.close()
  })
}
