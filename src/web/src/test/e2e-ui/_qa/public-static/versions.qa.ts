import { expect, test } from "../../_fixtures/case-fixture"
import { createHash } from "node:crypto"
import { composerEditable } from "../../_fixtures/actions"
import { tid } from "../../_fixtures/testids"
import {
  attachQa, createQaPhaseOwner, executingWorkerIdentity,
  expectReleasePrecache, observeCandidate, ownD1WsProbe, ownedBusiness,
  readNativeResource, releaseAssets, releaseDelta, requiredQaManifest,
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

test("real legacy N page adopts the verified same-protocol Nplus1 build without closing and retains text and mention draft", async ({ caseActors, caseResources }, testInfo) => {
  const phase = createQaPhaseOwner(caseResources, testInfo)
  await phase.switchTo("N")
  const actors = await caseActors(["alice", "bob"])
  const business = await ownedBusiness(actors, "alice", caseResources)
  await actors.seed.seedJoinServer("alice", "bob", business.serverId)
  const message = await business.write("legacy page retained message")
  await rootWorker(business.page)
  const manifest = requiredQaManifest()
  const from = manifest.releases.N, to = manifest.releases.Nplus1
  expect(to.mainBuildId).not.toBe(from.mainBuildId)
  const beforeIdentity = await executingWorkerIdentity(business.page, caseResources, testInfo, "activated")
  expect(beforeIdentity.sha256).toBe(from.swSha256)
  const ownBuild = () => business.page.locator('meta[name="alook-web-build"]')
  expect(await ownBuild().count()).toBe(0)
  const probe = () => business.page.evaluate(() => new Promise<{ schemaVersion: number; buildId?: string } | null>(resolve => {
    const controller = navigator.serviceWorker.controller
    if (!controller) { resolve(null); return }
    const channel = new MessageChannel()
    const timer = setTimeout(() => finish(null), 1500)
    const finish = (value: { schemaVersion: number; buildId?: string } | null) => {
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      resolve(value)
    }
    channel.port1.onmessage = event => finish(event.data)
    controller.postMessage({ type: "alook:worker-version" }, [channel.port2])
  }))
  const legacy = await probe()
  expect(legacy?.schemaVersion).toBeGreaterThan(0)
  expect(legacy?.buildId).toBeUndefined()
  const editable = composerEditable(business.page)
  await editable.click()
  await editable.pressSequentially(`@${actors.userName("bob")}`)
  await business.page.getByRole("option").filter({ hasText: actors.userName("bob") }).click()
  await business.page.keyboard.type(" build draft")
  await expect(editable.locator(".mention-highlight")).toHaveText(`@${actors.userName("bob")}`)
  const draftKey = `c-composer-draft:${actors.userId("alice")}:${business.serverId}/${business.channelId}`
  const readDraft = () => business.page.evaluate(key => localStorage.getItem(key), draftKey)
  const draft = await readDraft()
  expect(draft).toContain('"type":"mention"')
  expect(draft).toContain(actors.userId("bob"))
  expect(draft).toContain("build draft")
  const me = await business.context.newPage()
  await me.goto("/c/me")
  expect(await me.locator('meta[name="alook-web-build"]').count()).toBe(0)
  const beforeNative = await expectReleasePrecache(business.page, "N")
  const delta = releaseDelta(releaseAssets("N"), releaseAssets("Nplus1"))
  expect(delta.added.length + delta.deleted.length + delta.changed.length).toBeGreaterThan(0)
  const unexpectedSends: string[] = []
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/community/channels/${business.channelId}/messages`) unexpectedSends.push(request.method())
  }
  business.context.on("request", onRequest)
  const candidate = observeCandidate(business.context, caseResources)
  await phase.switchTo("Nplus1")
  await updateRoot(business.page)
  await withinQaDeadline(candidate.promise, caseResources.deadline)
  await expect(ownBuild()).toHaveAttribute("content", to.mainBuildId)
  await expect(me.locator('meta[name="alook-web-build"]')).toHaveAttribute("content", to.mainBuildId)
  const activated = await executingWorkerIdentity(business.page, caseResources, testInfo, "activated")
  expect(activated.sha256).toBe(to.swSha256)
  expect(activated.versionId).not.toBe(beforeIdentity.versionId)
  const current = await probe()
  expect(current).toEqual({ schemaVersion: legacy!.schemaVersion, buildId: to.mainBuildId })
  expect(new URL(business.page.url()).pathname).toBe(`/c/channels/${business.serverId}/${business.channelId}`)
  await expect(business.page.getByText(message.content, { exact: true }).first()).toBeVisible()
  expect(await business.read(message.id)).toMatchObject({ id: message.id, seq: message.seq, content: message.content })
  await expect(editable).toContainText("build draft")
  await expect(editable.locator(".mention-highlight")).toHaveText(`@${actors.userName("bob")}`)
  expect(await readDraft()).toBe(draft)
  expect(unexpectedSends).toEqual([])
  business.context.off("request", onRequest)
  await business.page.getByTestId(tid.userSettingsOpen).click()
  await business.page.getByTestId(tid.settingsTab("advanced")).click()
  const version = business.page.getByTestId(tid.settingsWebVersion).locator("[data-web-build-id]")
  await expect(version).toHaveAttribute("data-web-build-id", to.mainBuildId)
  await expect(version).toHaveText(`Build ${to.mainBuildId}`)
  const afterNative = await expectReleasePrecache(business.page, "Nplus1")
  const nativeEntry = (snapshot: typeof beforeNative, url: string) => Object.entries(snapshot.caches).filter(([name]) => name.startsWith("alook-public-precache-")).flatMap(([, entries]) => entries).find(entry => new URL(entry.url).pathname === url)
  const changedKeys = delta.changed.map(url => {
    const before = nativeEntry(beforeNative, url)!, after = nativeEntry(afterNative, url)!
    expect(after.url).not.toBe(before.url)
    expect(after.sha256).not.toBe(before.sha256)
    const previousRevision = releaseAssets("N").find(asset => asset.url === url)!.revision
    const nextRevision = releaseAssets("Nplus1").find(asset => asset.url === url)!.revision
    expect(nextRevision).not.toBe(previousRevision)
    return { url, previousRevision, nextRevision, before, after }
  })
  for (const url of delta.unchanged) expect(nativeEntry(afterNative, url)?.url).toBe(nativeEntry(beforeNative, url)?.url)
  for (const url of delta.deleted) expect(nativeEntry(afterNative, url)).toBeUndefined()
  for (const path of [...delta.added.slice(0, 1), ...delta.changed, ...delta.unchanged.slice(0, 1)]) {
    const asset = releaseAssets("Nplus1").find(asset => asset.url === path)!
    expect(await readNativeResource(business.page, path)).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256, fromServiceWorker: true })
  }
  const shell = releaseAssets("Nplus1").find(asset => asset.url.startsWith("/community-shell/"))
  expect(shell).toBeTruthy()
  const response = await business.page.request.get(new URL(shell!.url, business.page.url()).href)
  expect(response.status()).toBe(200)
  const cacheControl = response.headers()["cache-control"]
  for (const value of ["public", "immutable", "no-transform"]) expect(cacheControl).toContain(value)
  const shellBody = await response.body()
  expect(createHash("sha256").update(shellBody).digest("hex")).toBe(shell!.url.split("/").at(-1))
  await attachQa(testInfo, "real-legacy-open-page-build-update", {
    from: { mainBuildId: from.mainBuildId, pageBuildField: "absent", worker: legacy, identity: beforeIdentity },
    to: { mainBuildId: to.mainBuildId, pageBuildId: await ownBuild().getAttribute("content"), worker: current, identity: activated },
    draftSha256: createHash("sha256").update(draft!).digest("hex"), unexpectedSends, message,
    delta, changedKeys, beforeNative, afterNative, shell: { url: shell!.url, bytes: shellBody.length, cacheControl, sha256: createHash("sha256").update(shellBody).digest("hex") },
    changedRevisionStatus: changedKeys.length ? "actual emitted revisions, complete native keys and bound bytes differ" : "NOT_PROVEN: this real pair has no same-URL changed body",
  })
  await candidate.close()
  await phase.close()
})
