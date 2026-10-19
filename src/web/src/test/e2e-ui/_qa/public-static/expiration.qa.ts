import { expect, test } from "../../_fixtures/case-fixture"
import { publicRuntimeAssetKind } from "../../../../lib/service-worker/public-cache"
import {
  actualRuntimeAsset, attachQa, expectNativeBody, expectUnrelatedNativeState, ownedOffline,
  prepareUnrelatedNativeState, publicNativeSnapshot, readNativeResource, releaseAssets,
  rootWorker, runtimeName, seedNativeExpiration, seedNativeOverflow, warmBoundAsset,
} from "../../_fixtures/public-static-qa"

for (const kind of ["code", "fonts", "images"] as const) {
  test(`native ${kind} honors its unchanged age limit using explicitly artificial aged state`, async ({ caseResources }, testInfo) => {
    const context = await caseResources.newContext()
    const page = await context.newPage()
    await page.goto("/blog")
    await rootWorker(page)
    await page.goto("/robots.txt")
    const asset = actualRuntimeAsset("Nplus1", kind)
    const resource = await warmBoundAsset(page, asset)
    const sentinel = await prepareUnrelatedNativeState(page, testInfo.testId)
    const name = runtimeName(kind), ageMs = (kind === "images" ? 7 : 30) * 86_400_000
    const fresh = await seedNativeExpiration(page, name, asset.url, Date.now() - ageMs + 60_000)
    await ownedOffline(caseResources, context, async () => { expect(await readNativeResource(page, asset.url)).toEqual(resource) })
    const stale = await seedNativeExpiration(page, name, asset.url, Date.now() - ageMs - 60_000)
    await ownedOffline(caseResources, context, async () => {
      expect(await page.evaluate(async url => { try { await fetch(url, { credentials: "omit", cache: "no-store" }); return "resolved" } catch { return "rejected" } }, asset.url)).toBe("rejected")
    })
    await expect.poll(async () => (await publicNativeSnapshot(page, [name])).caches[name]?.some(entry => entry.url === resource.url) ?? false).toBe(false)
    await warmBoundAsset(page, asset)
    const onlineStale = await seedNativeExpiration(page, name, asset.url, Date.now() - ageMs - 60_000)
    const replacement = await warmBoundAsset(page, asset)
    expect(replacement).toEqual(resource)
    await expect.poll(async () => (await publicNativeSnapshot(page, [name])).expiration.find(row => row.cacheName === name && row.url === resource.url)?.timestamp ?? 0).toBeGreaterThan(Date.now() - 60_000)
    expect(await readNativeResource(page, asset.url)).toEqual(resource)
    await expectNativeBody(page, name, resource)
    await expectUnrelatedNativeState(page, sentinel)
    await attachQa(testInfo, `native-${kind}-age`, { fresh, stale, onlineStale, resource, replacement, policy: { maxAgeDays: kind === "images" ? 7 : 30 }, after: await publicNativeSnapshot(page, [name]) })
  })
}

test("129 actual image downloads enforce the production 128 entry bound", async ({ caseResources }, testInfo) => {
  const context = await caseResources.newContext()
  const page = await context.newPage()
  await page.goto("/blog")
  await rootWorker(page)
  await page.goto("/robots.txt")
  const name = runtimeName("images")
  const assets = releaseAssets("Nplus1").filter(asset => asset.zone === "blog" && publicRuntimeAssetKind(asset.url) === "images").slice(0, 129)
  expect(assets).toHaveLength(129)
  const first = await warmBoundAsset(page, assets[0]!)
  const sentinel = await prepareUnrelatedNativeState(page, testInfo.testId)
  await seedNativeExpiration(page, name, first.url, Date.now() - 60_000)
  const downloads = [first]
  for (const asset of assets.slice(1)) {
    const resource = await readNativeResource(page, asset.url)
    expect(resource).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256, fromServiceWorker: true })
    downloads.push(resource)
  }
  await expect.poll(async () => {
    const snapshot = await publicNativeSnapshot(page, [name])
    return { entries: snapshot.caches[name]?.length, rows: snapshot.expiration.filter(row => row.cacheName === name).length, oldestPresent: snapshot.caches[name]?.some(entry => entry.url === first.url) }
  }).toEqual({ entries: 128, rows: 128, oldestPresent: false })
  await expectNativeBody(page, name, downloads.at(-1)!)
  await expectUnrelatedNativeState(page, sentinel)
  await attachQa(testInfo, "129-distinct-real-image-downloads", { preparation: "129 distinct admitted release URLs, no query aliases", policy: { maxEntries: 128 }, downloads, after: await publicNativeSnapshot(page, [name]) })
})

for (const [kind, maxEntries] of [["code", 80], ["fonts", 160]] as const) {
  test(`native ${kind} evicts artificial overflow to the unchanged ${maxEntries} entry bound`, async ({ caseResources }, testInfo) => {
    const context = await caseResources.newContext()
    const page = await context.newPage()
    await page.goto("/blog")
    await rootWorker(page)
    await page.goto("/robots.txt")
    const asset = actualRuntimeAsset("Nplus1", kind)
    const resource = await warmBoundAsset(page, asset)
    const sentinel = await prepareUnrelatedNativeState(page, testInfo.testId)
    const fixture = await seedNativeOverflow(page, kind, maxEntries + 1, asset.url)
    expect(fixture.entries).toHaveLength(maxEntries + 1)
    expect(await readNativeResource(page, asset.url)).toEqual(resource)
    await expect.poll(async () => {
      const snapshot = await publicNativeSnapshot(page, [runtimeName(kind)])
      return { entries: snapshot.caches[runtimeName(kind)]?.length, rows: snapshot.expiration.filter(row => row.cacheName === runtimeName(kind)).length, oldestPresent: snapshot.caches[runtimeName(kind)]?.some(entry => entry.url === fixture.entries[0]!.url) }
    }).toEqual({ entries: maxEntries, rows: maxEntries, oldestPresent: false })
    await expectNativeBody(page, runtimeName(kind), resource)
    await expectUnrelatedNativeState(page, sentinel)
    await attachQa(testInfo, `artificial-${kind}-overflow`, { fixture, realTemplate: resource, maxEntries, after: await publicNativeSnapshot(page, [runtimeName(kind)]) })
  })
}
