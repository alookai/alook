import type { Locator, Page, Response } from "@playwright/test"
import { AccountAttentionSnapshotSchema } from "@alook/shared"
import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"

async function indicatorHeight(indicator: Locator) {
  return indicator.evaluate((element) => element.getBoundingClientRect().height)
}

async function expectIndicatorHeight(indicator: Locator, height: number) {
  await expect.poll(() => indicatorHeight(indicator), { timeout: 20_000 }).toBe(height)
}

async function combineServers(page: Page, sourceId: string, targetId: string) {
  const sourceButton = page.getByTestId(tid.serverIcon(sourceId))
  const targetButton = page.getByTestId(tid.serverIcon(targetId))
  await sourceButton.focus()
  await targetButton.focus()
  const source = sourceButton
    .locator("xpath=ancestor::*[@draggable='true'][1]")
  const target = targetButton
    .locator("xpath=ancestor::*[@draggable='true'][1]")
  await expect(source).toHaveCount(1)
  await expect(target).toHaveCount(1)
  const targetBox = await target.boundingBox()
  if (!targetBox) throw new Error("server rail drag target is outside the viewport")
  let responseStatus: number | null = null
  const captureResponse = (candidate: Response) => {
    if (
      candidate.request().method() === "PATCH"
      && new URL(candidate.url()).pathname === "/api/community/users/me/server-rail"
    ) responseStatus = candidate.status()
  }
  page.on("response", captureResponse)
  try {
    for (let attempt = 0; attempt < 3 && responseStatus === null; attempt += 1) {
      await source.dragTo(target, {
        targetPosition: { x: targetBox.width / 2, y: targetBox.height / 2 },
        force: true,
      })
      await page.waitForTimeout(250)
    }
    expect(responseStatus).toBe(200)
  } finally {
    page.off("response", captureResponse)
  }
}

test("server unread owns exact rail geometry, folder aggregation, read clear, and mobile parity", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(150_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser, userId } = actors
  const { memberInfo, seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

  const stamp = Date.now()
  const foregroundServer = await seedServer("alice", `Unread foreground ${stamp}`)
  const backgroundServer = await seedServer("alice", `Unread background ${stamp}`)
  const neutralServer = await seedServer("alice", `Unread neutral ${stamp}`)
  const foregroundChannel = await seedChannel("alice", foregroundServer, `foreground-${stamp}`)
  const backgroundChannel = await seedChannel("alice", backgroundServer, `background-${stamp}`)
  await seedJoinServer("alice", "bob", foregroundServer)
  await seedJoinServer("alice", "bob", backgroundServer)
  await seedJoinServer("alice", "bob", neutralServer)
  const bobInfo = await memberInfo("alice", backgroundServer, userId("bob"))
  const { page, context } = await asUser("bob", {
    recordVideo: { dir: testInfo.outputPath("server-digits-video"), size: { width: 1280, height: 900 } },
  })
  const ws = await proxyCommunityWebSockets(context)
  const snapshots: Array<Record<string, unknown>> = []
  const video = page.video()
  actors.onCleanup(async () => {
    try {
      await testInfo.attach("server-digits-stages.json", {
        body: JSON.stringify({ snapshots, frames: ws.frames }, null, 2), contentType: "application/json",
      })
    } finally {
      await caseResources.closeContext(context)
      if (video) await testInfo.attach("server-hidden-message-return-video", {
        path: await video.path(), contentType: "video/webm",
      })
    }
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${foregroundServer}/${foregroundChannel}`)
  await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toBeVisible({ timeout: 30_000 })

  const indicatorBefore = (testId: string) => page.getByTestId(testId)
    .locator('xpath=preceding-sibling::*[@data-slot="community-server-rail-indicator"][1]')
  const foregroundIndicator = page.getByTestId(tid.serverRailIndicator(foregroundServer))
  const homeButton = page.getByTestId(tid.homeButton)
  const homeIndicator = indicatorBefore(tid.homeButton)
  const addButton = page.getByTestId(tid.serverAdd)
  const addIndicator = indicatorBefore(tid.serverAdd)
  await expectIndicatorHeight(foregroundIndicator, 32)
  await expectIndicatorHeight(homeIndicator, 0)
  await homeButton.hover()
  await expectIndicatorHeight(homeIndicator, 20)
  await page.mouse.move(300, 300)
  await expectIndicatorHeight(homeIndicator, 0)
  await addButton.hover()
  await expectIndicatorHeight(addIndicator, 20)
  await page.mouse.move(300, 300)
  await expectIndicatorHeight(addIndicator, 0)

  const backgroundIndicator = page.getByTestId(tid.serverRailIndicator(backgroundServer))
  await expectIndicatorHeight(backgroundIndicator, 0)
  const firstBody = `background unread ${stamp}`
  await seedMessage("alice", backgroundChannel, firstBody)
  await expectIndicatorHeight(backgroundIndicator, 10)

  const backgroundIcon = page.getByTestId(tid.serverIcon(backgroundServer))
  await backgroundIcon.hover()
  await expectIndicatorHeight(backgroundIndicator, 20)
  await page.mouse.move(300, 300)
  await expectIndicatorHeight(backgroundIndicator, 10)
  await backgroundIcon.focus()
  await expectIndicatorHeight(backgroundIndicator, 20)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)

  await combineServers(page, backgroundServer, neutralServer)
  const folder = page.locator(`[data-testid^="${tid.serverRailFolder("")}"]`).first()
  await expect(folder).toBeVisible()
  const folderTestId = await folder.getAttribute("data-testid")
  if (!folderTestId) throw new Error("missing folder testid")
  const folderId = folderTestId.slice(tid.serverRailFolder("").length)
  const folderIndicator = page.getByTestId(tid.serverRailFolderIndicator(folderId))
  await page.mouse.move(300, 300)
  await page.getByRole("link", { name: "Home" }).focus()
  await expectIndicatorHeight(folderIndicator, 0)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)
  await folder.click()
  await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toHaveCount(0)
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(folderIndicator, 10)
  await folder.click()
  await expect(backgroundIcon).toBeVisible()
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  await expectIndicatorHeight(backgroundIndicator, 10)

  await backgroundIcon.click()
  await expectIndicatorHeight(backgroundIndicator, 32)
  await folder.click()
  await expect(page.getByTestId(tid.serverIcon(backgroundServer))).toHaveCount(0)
  await expectIndicatorHeight(folderIndicator, 32)
  await folder.click()
  await expect(backgroundIcon).toBeVisible()
  await expectIndicatorHeight(backgroundIndicator, 32)
  const backgroundChannelRow = page.getByTestId(tid.channelRow(backgroundChannel))
  await expect(backgroundChannelRow).toBeVisible({ timeout: 30_000 })
  const readResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${backgroundChannel}/read`
  ))
  await page.goto(`/c/channels/${backgroundServer}/${backgroundChannel}`)
  await expect(page.getByText(firstBody, { exact: true })).toBeVisible({ timeout: 30_000 })
  expect((await readResponse).status()).toBe(200)
  await page.getByTestId(tid.serverIcon(foregroundServer)).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(
    `/c/channels/${foregroundServer}/${foregroundChannel}`,
  )
  await expectIndicatorHeight(folderIndicator, 0)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${foregroundServer}`)
  if (await backgroundIcon.count() === 0) {
    await folder.click()
    await expect(backgroundIcon).toBeVisible()
  }
  await page.mouse.move(300, 300)
  await page.getByTestId(tid.serverIcon(foregroundServer)).focus()
  const alice = await asUser("alice")
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${backgroundServer}/${backgroundChannel}`)
  const editable = composerEditable(alice.page)
  const sendMention = async (content: string) => {
    const frameStart = ws.frames.length
    const response = alice.page.waitForResponse((candidate) => (
      candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/api/community/channels/${backgroundChannel}/messages`
    ))
    void response.catch(() => {})
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
    await editable.pressSequentially(` ${content}`)
    await alice.page.keyboard.press("Enter")
    const result = await response
    expect(result.status()).toBe(201)
    const messageId = (await result.json() as { message: { id: string } }).message.id
    await expect.poll(() => {
      const events = ws.frames.slice(frameStart).flatMap(communityFrameEvents)
      return events.some((event) => event.type === "community:message.create" && event.message?.id === messageId)
        && events.some((event) => event.type === "community:unread.bump"
          && event.channelId === backgroundChannel && event.serverId === backgroundServer
          && event.userId === userId("bob") && event.isMention === true)
    }).toBe(true)
    snapshots.push({ stage: "mention-receipt", at: Date.now(), content, messageId,
      status: result.status(), events: ws.frames.slice(frameStart).flatMap(communityFrameEvents) })
    return messageId
  }
  const secondBody = `mobile background mention ${stamp}`
  await sendMention(secondBody)
  await expectIndicatorHeight(backgroundIndicator, 10)
  await expect(page.getByTestId(tid.railUnreadBadge(backgroundServer))).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("server-rail-unread-390.png"),
    fullPage: true,
  })

  const seed = await page.request.get("/api/community/servers")
  expect(seed.status()).toBe(200)
  const body = await seed.json() as { servers: Array<{ id: string; unread: boolean }> }
  expect(body.servers.find((server) => server.id === backgroundServer)?.unread).toBe(true)

  const badge = page.getByTestId(tid.railUnreadBadge(backgroundServer))
  const flow = badge.locator("number-flow-react")
  const railContainer = backgroundIcon.locator("xpath=ancestor::nav[1]/..")
  const readDigits = () => flow.evaluate((element) => {
    const number = element.shadowRoot?.querySelector<HTMLElement>('[part="number"]')
    const bounds = number?.getBoundingClientRect()
    const badgeBounds = element.parentElement!.getBoundingClientRect()
    const characters = [...element.shadowRoot?.querySelectorAll<HTMLElement>(
      '[part~="integer"] > [part~="digit"]:not([inert]) .digit__num:not([inert])',
    ) ?? []]
    return {
      text: characters.map((character) => character.textContent).join(""),
      width: bounds?.width ?? 0, height: bounds?.height ?? 0,
      storedWidth: number?.style.getPropertyValue("--width") ?? "",
      characters: characters.map((character) => {
        const rect = character.getBoundingClientRect()
        const style = getComputedStyle(character)
        return { text: character.textContent, width: rect.width, height: rect.height,
          visibility: style.visibility, opacity: style.opacity,
          intersectsBadge: rect.right > badgeBounds.left && rect.left < badgeBounds.right
            && rect.bottom > badgeBounds.top && rect.top < badgeBounds.bottom }
      }),
      animations: element.shadowRoot?.getAnimations().map((animation) => ({
        playState: animation.playState, pending: animation.pending, currentTime: animation.currentTime,
      })) ?? [],
    }
  })
  const expectPrimaryCount = async (stage: string, count: number) => {
    const response = await page.request.get("/api/community/users/me/attention")
    expect(response.status()).toBe(200)
    const raw: unknown = await response.json()
    expect(raw).not.toHaveProperty("stale", true)
    const snapshot = AccountAttentionSnapshotSchema.parse(raw)
    const actualCount = snapshot.scopes.filter((scope) => scope.serverId === backgroundServer)
      .reduce((total, scope) => total + scope.attentionCount, 0)
    snapshots.push({ stage: `${stage}-primary`, at: Date.now(), count, actualCount,
      status: response.status(), snapshot })
    expect(actualCount).toBe(count)
  }
  const capture = async (stage: string, count: number) => {
    const mounted = await flow.count()
    snapshots.push({ stage, at: Date.now(), count, mounted, digits: mounted ? await readDigits() : null })
    await testInfo.attach(`server-digits-${stage}.png`, {
      body: await page.screenshot(), contentType: "image/png",
    })
    if (await badge.isVisible()) await testInfo.attach(`server-digits-${stage}-badge.png`, {
      body: await badge.screenshot(), contentType: "image/png",
    })
  }
  const expectVisibleDigits = async (stage: string, count: number) => {
    await expect(badge).toBeVisible()
    await expect(flow).toHaveCount(1)
    await expect.poll(async () => (await readDigits()).text).toBe(String(count))
    await capture(`${stage}-transition`, count)
    await expect.poll(async () => (await readDigits()).animations.filter((animation) => (
      animation.playState === "running" || animation.pending
    )).length).toBe(0)
    const digits = await readDigits()
    expect(digits.width).toBeGreaterThan(0)
    expect(digits.height).toBeGreaterThan(0)
    expect(digits.characters).toHaveLength(String(count).length)
    for (const character of digits.characters) {
      expect(character.width).toBeGreaterThan(0)
      expect(character.height).toBeGreaterThan(0)
      expect(character.visibility).toBe("visible")
      expect(Number(character.opacity)).toBeGreaterThan(0)
      expect(character.intersectsBadge).toBe(true)
    }
    await expectPrimaryCount(stage, count)
    await capture(stage, count)
  }
  await expectVisibleDigits("visible", 1)
  for (let count = 2; count <= 9; count += 1) {
    await sendMention(`Server digit precondition ${stamp} ${count}`)
    await expect.poll(async () => (await readDigits()).text).toBe(String(count))
  }
  await expectVisibleDigits("before-detail", 9)
  const retained = await flow.elementHandle()
  expect(retained).not.toBeNull()
  await page.getByTestId(tid.channelRow(foregroundChannel)).click()
  await expect(page).toHaveURL(`/c/channels/${foregroundServer}/${foregroundChannel}`)
  await expect(railContainer).toHaveCSS("display", "none")
  await expect(railContainer).toHaveAttribute("inert", "")
  let lastMessageId = await sendMention(`Hidden Server digit ${stamp}`)
  await expect.poll(async () => (await readDigits()).text).toBe("10")
  await expectPrimaryCount("hidden-update", 10)
  await capture("hidden-update", 10)
  await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
  await expect(page).toHaveURL(`/c/channels/${foregroundServer}`)
  expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
  await expectVisibleDigits("first-return", 10)

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.getByTestId(tid.channelRow(foregroundChannel)).click()
    await expect(railContainer).toHaveCSS("display", "none")
    lastMessageId = await sendMention(`Repeated hidden Server ${stamp} ${cycle}`)
    const count = 11 + cycle
    await expect.poll(async () => (await readDigits()).text).toBe(String(count))
    await expectPrimaryCount(`hidden-repeat-${cycle}`, count)
    await capture(`hidden-repeat-${cycle}`, count)
    await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
    await expect(page).toHaveURL(`/c/channels/${foregroundServer}`)
    expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(true)
    await expectVisibleDigits(`repeat-return-${cycle}`, count)
  }

  await backgroundIcon.click()
  await expect(page).toHaveURL(`/c/channels/${backgroundServer}`)
  const clearResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${backgroundChannel}/read`
  ))
  void clearResponse.catch(() => {})
  await page.getByTestId(tid.channelRow(backgroundChannel)).click()
  await expect(page.getByTestId(tid.message(lastMessageId))).toBeVisible()
  expect((await clearResponse).status()).toBe(200)
  await expect(badge).toHaveCount(0)
  await expectPrimaryCount("read-clear", 0)
  await capture("read-clear", 0)
  await page.getByRole("banner").getByRole("button", { name: "Back", exact: true }).click()
  await expect(page).toHaveURL(`/c/channels/${backgroundServer}`)
  await expect(badge).toHaveCount(0)
  await sendMention(`Server positive again ${stamp}`)
  await expectVisibleDigits("positive-again", 1)
  expect(await flow.evaluate((element, prior) => element === prior, retained)).toBe(false)
  const beforeFolder = await flow.elementHandle()
  expect(beforeFolder).not.toBeNull()
  await folder.click()
  await expect(backgroundIcon).toHaveCount(0)
  await sendMention(`Server folder update ${stamp}`)
  await expectPrimaryCount("folder-unmounted", 2)
  await capture("folder-unmounted", 2)
  await folder.click()
  await expectVisibleDigits("folder-remount", 2)
  expect(await flow.evaluate((element, prior) => element === prior, beforeFolder)).toBe(false)
})


test("Home retains touch focus without an inactive bar and keeps keyboard feedback", async ({ caseActors }) => {
  test.setTimeout(150_000)
  const actors = await caseActors(["alice", "bob"])
  const serverId = await actors.seed.seedServer("alice", `Touch focus ${Date.now()}`)
  const otherServerId = await actors.seed.seedServer("alice", `Touch target ${Date.now()}`)
  await actors.seed.seedJoinServer("alice", "bob", serverId)
  await actors.seed.seedJoinServer("alice", "bob", otherServerId)
  const { page } = await actors.asUser("bob", {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  })
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}`)
  const home = page.getByTestId(tid.homeButton)
  const server = page.getByTestId(tid.serverIcon(serverId))
  const homeIndicator = home.locator("xpath=preceding-sibling::*[@data-slot='community-server-rail-indicator']")
  await home.tap()
  await expect(page).toHaveURL(/\/c\/me$/)
  await expect(home).toHaveAttribute("aria-current", "page")
  await expectIndicatorHeight(homeIndicator, 32)
  await server.tap()
  await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}$`))
  await expect(server).toHaveAttribute("aria-current", "page")
  await expect(home).not.toHaveAttribute("aria-current", "page")
  await expectIndicatorHeight(page.getByTestId(tid.serverRailIndicator(serverId)), 32)
  await home.focus()
  expect(await home.evaluate((element) => element.matches(":focus-visible"))).toBe(false)
  await expectIndicatorHeight(homeIndicator, 0)
  await page.keyboard.press("Tab")
  await home.focus()
  expect(await home.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
  await expectIndicatorHeight(homeIndicator, 20)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/c\/me$/)
  await expectIndicatorHeight(homeIndicator, 32)
})
