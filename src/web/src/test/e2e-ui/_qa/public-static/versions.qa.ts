import { expect, test } from "../../_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "../../_fixtures/actions"
import {
  activateAfterClientExit, attachQa, createQaPhaseOwner, executingWorkerIdentity,
  expectReleasePrecache, observeCandidate, ownD1WsProbe, ownedBusiness,
  readNativeResource, releaseAssets, releaseDelta, requiredQaManifest, rootStates,
  rootWorker, updateRoot, withinQaDeadline,
} from "../../_fixtures/public-static-qa"

test("@phase-capability Main and stable WS share bidirectional D1 and retain their actual connections", async ({ caseActors, caseResources }, testInfo) => {
  const phase = createQaPhaseOwner(caseResources, testInfo)
  await phase.switchTo("N")
  const actors = await caseActors(["alice"])
  const business = await ownedBusiness(actors, "alice", caseResources)
  const machine = await ownD1WsProbe(actors, caseResources, testInfo)
  const before = await machine.writeAndRead("before")
  const message = await business.write("phase capability before switch")
  const connections = business.proxy.connectionCount()
  expect(connections).toBe(1)
  await phase.switchTo("Nplus1")
  const after = await machine.writeAndRead("after")
  expect(await business.read(message.id)).toMatchObject({ id: message.id, seq: message.seq, content: message.content })
  const next = await business.write("phase capability after switch")
  expect(next.seq).toBeGreaterThan(message.seq)
  expect(business.proxy.connectionCount()).toBe(connections)
  await attachQa(testInfo, "real-bidirectional-d1-and-continuous-ws", { before, after, messages: [message, next], humanConnectionCount: connections, connectionFrames: business.proxy.connectionFrames })
  await machine.close()
  await phase.close()
})

for (const [from, to] of [["N", "Nplus1"], ["Nplus1", "N"]] as const) {
  test(`${from} to ${to} waits for real clients, activates naturally and preserves business facts`, async ({ caseActors, caseResources }, testInfo) => {
    const phase = createQaPhaseOwner(caseResources, testInfo)
    await phase.switchTo(from)
    const actors = await caseActors(["alice"])
    const business = await ownedBusiness(actors, "alice", caseResources)
    const machine = await ownD1WsProbe(actors, caseResources, testInfo)
    const message = await business.write(`${from} retained message`)
    await rootWorker(business.page)
    const me = await business.context.newPage()
    await me.goto("/c/me")
    const article = await business.context.newPage()
    await article.goto("/blog")
    const link = article.locator('a[href^="/blog/"]').first()
    await expect(link).toBeVisible()
    const href = await link.getAttribute("href")
    expect(href).toMatch(/^\/blog\/.+/)
    await article.goto(href!)
    const manifest = requiredQaManifest()
    const beforeIdentity = await executingWorkerIdentity(business.page, caseResources, testInfo, "activated")
    expect(beforeIdentity.sha256).toBe(manifest.releases[from].swSha256)
    const delta = releaseDelta(releaseAssets(from), releaseAssets(to))
    const beforeNative = await expectReleasePrecache(business.page, from)
    expect(delta.added.length + delta.deleted.length + delta.changed.length).toBeGreaterThan(0)
    const selected = releaseAssets(from).find(asset => asset.precache && delta.unchanged.includes(asset.url))!
    expect(selected).toBeTruthy()
    const beforeResource = await readNativeResource(business.page, selected.url)
    expect(beforeResource).toMatchObject({ bytes: selected.bytes, sha256: selected.sha256, fromServiceWorker: true })
    const oldBranchResources = []
    for (const url of [...delta.changed, ...delta.deleted.slice(0, 1)]) {
      const asset = releaseAssets(from).find(asset => asset.url === url)!
      const resource = await readNativeResource(business.page, url)
      expect(resource).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256, fromServiceWorker: true })
      oldBranchResources.push(resource)
    }
    const beforeD1 = await machine.writeAndRead("before")
    const connections = business.proxy.connectionCount()
    const candidate = observeCandidate(business.context, caseResources)
    await phase.switchTo(to)
    await updateRoot(business.page)
    await expect.poll(() => rootStates(business.page)).toMatchObject({ active: "activated", waiting: "installed" })
    await withinQaDeadline(candidate.promise, caseResources.deadline)
    const waiting = await executingWorkerIdentity(business.page, caseResources, testInfo, "installed")
    expect(waiting.sha256).toBe(manifest.releases[to].swSha256)
    const active = await executingWorkerIdentity(business.page, caseResources, testInfo, "activated")
    expect(active.sha256).toBe(beforeIdentity.sha256)
    expect(await readNativeResource(business.page, selected.url)).toEqual(beforeResource)
    for (const resource of oldBranchResources) expect(await readNativeResource(business.page, resource.url)).toEqual(resource)
    expect(await business.read(message.id)).toMatchObject({ id: message.id, seq: message.seq, content: message.content })
    const next = await business.write(`${to} server with old controlled client`)
    const afterD1 = await machine.writeAndRead("after")
    expect(business.proxy.connectionCount()).toBe(connections)
    await attachQa(testInfo, "retained-clients-and-waiting-worker", { from, to, delta, beforeIdentity, active, waiting, beforeD1, afterD1, messages: [message, next], connections, connectionFrames: business.proxy.connectionFrames })
    await candidate.close()
    const neutral = await activateAfterClientExit(business.context, caseResources, [business.page, me, article], waiting.versionId, testInfo)
    const activated = await executingWorkerIdentity(neutral, caseResources, testInfo, "activated")
    expect(activated.sha256).toBe(manifest.releases[to].swSha256)
    expect(activated.versionId).not.toBe(beforeIdentity.versionId)
    const afterNative = await expectReleasePrecache(neutral, to)
    const nativeEntry = (snapshot: typeof beforeNative, url: string) => Object.entries(snapshot.caches).filter(([name]) => name.startsWith("alook-public-precache-")).flatMap(([, entries]) => entries).find(entry => new URL(entry.url).pathname === url)
    const changedKeys = delta.changed.map(url => {
      const before = nativeEntry(beforeNative, url)!, after = nativeEntry(afterNative, url)!
      expect(after.url).not.toBe(before.url)
      expect(after.sha256).not.toBe(before.sha256)
      const previousRevision = releaseAssets(from).find(asset => asset.url === url)!.revision
      const nextRevision = releaseAssets(to).find(asset => asset.url === url)!.revision
      expect(nextRevision).not.toBe(previousRevision)
      return { url, previousRevision, nextRevision, before, after }
    })
    for (const url of delta.unchanged) expect(nativeEntry(afterNative, url)?.url).toBe(nativeEntry(beforeNative, url)?.url)
    for (const url of delta.deleted) expect(nativeEntry(afterNative, url)).toBeUndefined()
    for (const path of [...delta.added.slice(0, 1), ...delta.changed, ...delta.unchanged.slice(0, 1)]) {
      const asset = releaseAssets(to).find(asset => asset.url === path)!
      expect(await readNativeResource(neutral, path)).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256, fromServiceWorker: true })
    }
    await gotoAfterUserWsAuth(neutral, `/c/channels/${business.serverId}/${business.channelId}`)
    await expect(neutral.getByText(message.content, { exact: true }).first()).toBeVisible()
    expect(await business.read(message.id)).toMatchObject({ id: message.id, seq: message.seq })
    await attachQa(testInfo, "naturally-activated-release", { from, to, activated, oldBranchResources, changedKeys, beforeNative, afterNative, changedRevisionStatus: changedKeys.length ? "actual emitted revisions, complete native keys and bound bytes differ" : "NOT_PROVEN: this real pair has no same-URL changed body", finalD1: await machine.writeAndRead("activated") })
    await machine.close()
    await phase.close()
  })
}
