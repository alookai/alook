import { test, expect } from "./_fixtures/case-fixture"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, installScrollTraceInCurrentDocument, markScrollTrace, scrollTraceSelfTest, startScrollTrace } from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { VIEWPORT, holdNextRequest, seedProfile, identity, finishAndAttach, expectSkeletonTailGeometry, seedScrollCase, tracedAsUser } from "./_fixtures/message-scroll-characterization"

test.describe("message scroll characterization", () => {
test("cold and warm loading, older prepend, and jump-to-present remain observable", async ({ caseActors }, testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice", "bob", "carol"])
    const asUser = tracedAsUser(actors)
    const { serverId, coldChannelId, loadingChannelId, upwardChannelId, loadingProfile } = await seedScrollCase(actors)

    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const initialMessages = await holdNextRequest(actors,
      alice.page,
      `**/api/community/channels/${coldChannelId}/messages**`,
      () => true,
    )
    const image = await holdNextRequest(actors,
      alice.page,
      "**/icon-512.png?scroll-trace=1",
      () => true,
    )
    await alice.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
    await alice.page.getByTestId(tid.channelRow(coldChannelId)).click()
    const initialUrl = await initialMessages.matched
    expect(initialUrl.searchParams.has("anchor")).toBe(false)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await expect(scroller.locator('[data-slot="skeleton"]').first()).toBeVisible({ timeout: 20_000 })
    await expectSkeletonTailGeometry(alice.page, 1280, "desktop cold skeleton")
    const selfTest = await scrollTraceSelfTest(alice.page)
    expect(selfTest).toMatchObject({
      getterValue: 7,
      methodValue: 8,
      setterError: "RangeError",
      methodError: "RangeError",
      receiverPreserved: true,
      restored: true,
      unsupportedUntouched: true,
    })
    await startScrollTrace(alice.page, {
      scenario: "cold-load-and-async-row",
      identity: identity(coldChannelId),
    })
    await beginScrollTraceAnalysis(alice.page, "cold-load-and-async-row", {
      dataTransitionSource: "initial-cold",
    })
    await markScrollTrace(alice.page, "cold-request-held", { dataTransitionSource: "initial-cold" })
    const coldProfile = await seedProfile(actors, coldChannelId, 12, true, "alice")
    initialMessages.release()
    await image.matched
    await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!))).toBeVisible({ timeout: 30_000 })
    await markScrollTrace(alice.page, "async-image-release", {
      detail: { position: "tail", asset: "local-fixture" },
    })
    image.release()
    await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!)).locator("img")).toBeVisible()
    await endScrollTraceAnalysis(alice.page, "cold-load-and-async-row")
    const cold = await finishAndAttach(alice.page, testInfo)
    expect(cold.frames.some((frame) => frame.loaders.top.mounted || frame.rows.length === 0)).toBe(true)
    await initialMessages.dispose()
    await image.dispose()

    const mobile = await asUser("alice")
    await mobile.page.setViewportSize({ width: 390, height: 844 })
    const mobileInitialMessages = await holdNextRequest(actors,
      mobile.page,
      `**/api/community/channels/${coldChannelId}/messages**`,
      () => true,
    )
    await mobile.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
    await mobile.page.getByTestId(tid.channelRow(coldChannelId)).click()
    await mobileInitialMessages.matched
    await expect(mobile.page.getByTestId(tid.messageScroller)
      .locator('[data-slot="skeleton"]').first()).toBeVisible({ timeout: 20_000 })
    await expectSkeletonTailGeometry(mobile.page, 390, "mobile cold skeleton")
    mobileInitialMessages.release()
    await expect(mobile.page.getByTestId(tid.message(coldProfile.ids.at(-1)!)))
      .toBeVisible({ timeout: 30_000 })
    await mobileInitialMessages.dispose()

    await installScrollTraceInCurrentDocument(alice.page)
    await alice.page.getByTestId(tid.channelRow(upwardChannelId)).click()
    await alice.page.waitForURL(new RegExp(upwardChannelId), { waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.messageScroller)).toBeVisible()
    const warmRequest = await holdNextRequest(actors,
      alice.page,
      `**/api/community/channels/${coldChannelId}/messages**`,
      () => true,
      { required: false },
    )
    await alice.page.getByTestId(tid.channelRow(coldChannelId)).click()
    await alice.page.waitForURL(new RegExp(coldChannelId), { waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!))).toBeVisible({ timeout: 20_000 })
    await startScrollTrace(alice.page, {
      scenario: "warm-cache-reuse",
      identity: identity(coldChannelId),
      estimatedSizes: coldProfile.estimates,
    })
    await beginScrollTraceAnalysis(alice.page, "warm-cache-reuse", {
      dataTransitionSource: "initial-cache",
    })
    await markScrollTrace(alice.page, "cached-rows-painted", {
      dataTransitionSource: "initial-cache",
      detail: { renderedBeforeRelease: true, revalidationMatched: warmRequest.hasMatched() },
    })
    warmRequest.release()
    await endScrollTraceAnalysis(alice.page, "warm-cache-reuse")
    await finishAndAttach(alice.page, testInfo)
    await warmRequest.dispose()

    const anchored = await asUser("alice")
    await anchored.page.setViewportSize(VIEWPORT)
    await installScrollTrace(anchored.page)
    await anchored.page.goto(`/c/channels/${serverId}/${loadingChannelId}`, { waitUntil: "commit" })
    const anchoredScroller = anchored.page.getByTestId(tid.messageScroller)
    await expect.poll(() => anchoredScroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
    const newAction = anchored.page.getByTestId(tid.scrollToNew)
    await expect(newAction).toBeVisible({ timeout: 30_000 })
    await newAction.click()
    const anchoredNewDivider = anchored.page.getByTestId(tid.newDivider)
    await expect.poll(() => anchoredNewDivider.evaluate(element => Math.abs(element.getBoundingClientRect().top
      - element.closest('[data-testid="community-message-scroller"]')!.getBoundingClientRect().top))).toBeLessThanOrEqual(1)
    await expect(newAction).toBeHidden()
    await expect(async () => {
      expect(await anchoredNewDivider.count()).toBe(1)
      expect(await anchoredNewDivider.isVisible()).toBe(true)
    }).toPass({ timeout: 30_000 })
    await expect(anchored.page.getByTestId(tid.messageScroller)).toHaveAttribute("data-pagination-enabled", "true")
    const older = await holdNextRequest(actors,
      anchored.page,
      `**/api/community/channels/${loadingChannelId}/messages**`,
      (url) => url.searchParams.has("cursor"),
    )
    await startScrollTrace(anchored.page, {
      scenario: "older-loading-prepend",
      identity: identity(loadingChannelId),
      estimatedSizes: loadingProfile.estimates,
    })
    await beginScrollTraceAnalysis(anchored.page, "older-loading-prepend", {
      dataTransitionSource: "older-page",
      commandDirection: "backward",
    })
    await markScrollTrace(anchored.page, "stimulus:older-boundary", { dataTransitionSource: "older-page" })
    await anchored.page.getByTestId(tid.messageScroller).evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await older.matched
    await expect(anchored.page.getByText("Loading older messages…", { exact: true })).toBeVisible()
    older.release()
    await expect(anchored.page.getByText("Loading older messages…", { exact: true })).toHaveCount(0)
    await endScrollTraceAnalysis(anchored.page, "older-loading-prepend")
    const olderTrace = await finishAndAttach(anchored.page, testInfo)
    expect(olderTrace.marks.filter((mark) =>
      mark.name === "stimulus:older-boundary"
      && mark.dataTransitionSource === "older-page")).toHaveLength(1)
    await older.dispose()

    await installScrollTraceInCurrentDocument(anchored.page)
    const present = anchored.page.getByTestId(tid.scrollToPresent)
    await expect(present).toBeVisible({ timeout: 30_000 })
    let newestGets = 0
    anchored.page.on("request", (request) => {
      const url = new URL(request.url())
      if (
        request.method() === "GET"
        && url.pathname === `/api/community/channels/${loadingChannelId}/messages`
        && url.search === ""
      ) newestGets += 1
    })
    const newest = await holdNextRequest(actors,
      anchored.page,
      `**/api/community/channels/${loadingChannelId}/messages**`,
      (url) => url.search === "",
    )
    await startScrollTrace(anchored.page, {
      scenario: "newer-loading-present",
      identity: identity(loadingChannelId),
      estimatedSizes: loadingProfile.estimates,
    })
    await beginScrollTraceAnalysis(anchored.page, "newer-loading-present", {
      dataTransitionSource: "newer-page",
      commandDirection: "forward",
    })
    await markScrollTrace(anchored.page, "stimulus:jump-present", { dataTransitionSource: "newer-page" })
    await present.click()
    await newest.matched
    newest.release()
    await expect(anchored.page.getByTestId(tid.message(loadingProfile.ids.at(-1)!))).toBeVisible({ timeout: 30_000 })
    await expect(present).toHaveCount(0)
    await endScrollTraceAnalysis(anchored.page, "newer-loading-present")
    await finishAndAttach(anchored.page, testInfo)
    await expect.poll(() => newestGets).toBe(1)
    await anchored.page.waitForTimeout(500)
    expect(newestGets).toBe(1)
    await newest.dispose()
  })
})
