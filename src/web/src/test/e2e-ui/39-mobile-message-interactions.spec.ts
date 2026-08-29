import type { Locator, Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import {
  composerEditable,
  expectMessageVisible,
  gotoAfterUserWsAuth,
  ignoreNextDevToolsPointerCapture,
} from "./_fixtures/actions"
import {
  memberInfo,
  seedChannel,
  seedDm,
  seedJoinServer,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"

const TOUCH_QUERY = "(hover: hover) and (pointer: fine)"

async function installTouchPrimaryPointer(page: Page): Promise<void> {
  await page.addInitScript((touchQuery) => {
    const nativeMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query: string) => {
      if (query !== touchQuery) return nativeMatchMedia(query)
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList
    }
  }, TOUCH_QUERY)
}

function frameHasMessage(
  frame: CapturedCommunityFrame,
  channelId: string,
  messageId: string,
): boolean {
  return communityFrameEvents(frame).some((event) => (
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.id === messageId
  ))
}

async function dispatchSwipe(
  page: Page,
  messageId: string,
  delta: { x: number; y: number },
): Promise<void> {
  const message = page.getByTestId(tid.message(messageId))
  const row = message.locator("div.group").first()
  await expect(row).toBeVisible()
  await row.evaluate((element) => {
    ;(element as HTMLElement).setPointerCapture = () => {}
  })
  const box = await row.boundingBox()
  if (!box) throw new Error(`message row ${messageId} has no box`)
  const start = { x: box.x + Math.min(100, box.width / 2), y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 17, isPrimary: true, button: 0 }
  await row.dispatchEvent("pointerdown", { ...pointer, clientX: start.x, clientY: start.y })
  await row.dispatchEvent("pointermove", {
    ...pointer,
    buttons: 1,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y,
  })
  await row.dispatchEvent("pointerup", {
    ...pointer,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y,
  })
}

async function dispatchSwipePathAndClick(
  page: Page,
  messageId: string,
  deltas: Array<{ x: number; y: number }>,
): Promise<void> {
  const message = page.getByTestId(tid.message(messageId))
  const row = message.locator("div.group").first()
  await expect(row).toBeVisible()
  await row.evaluate((element) => {
    ;(element as HTMLElement).setPointerCapture = () => {}
  })
  const box = await row.boundingBox()
  if (!box) throw new Error(`message row ${messageId} has no box`)
  const start = { x: box.x + Math.min(100, box.width / 2), y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 19, isPrimary: true, button: 0 }
  await row.dispatchEvent("pointerdown", { ...pointer, clientX: start.x, clientY: start.y })
  for (const delta of deltas) {
    await row.dispatchEvent("pointermove", {
      ...pointer,
      buttons: 1,
      clientX: start.x + delta.x,
      clientY: start.y + delta.y,
    })
  }
  const release = deltas.at(-1) ?? { x: 0, y: 0 }
  await row.dispatchEvent("pointerup", {
    ...pointer,
    clientX: start.x + release.x,
    clientY: start.y + release.y,
  })
  await row.dispatchEvent("click", {
    clientX: start.x + release.x,
    clientY: start.y + release.y,
  })
}

async function dispatchLongPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error("long-press target has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 23, isPrimary: true, button: 0 }
  await target.dispatchEvent("pointerdown", { ...pointer, clientX: point.x, clientY: point.y })
  await page.waitForTimeout(550)
  await target.dispatchEvent("pointerup", { ...pointer, clientX: point.x, clientY: point.y })
}

async function dispatchCancelledAvatarPress(
  target: Locator,
  mode: "move" | "cancel",
): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error("avatar target has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 29, isPrimary: true, button: 0 }
  await target.dispatchEvent("pointerdown", { ...pointer, clientX: point.x, clientY: point.y })
  if (mode === "move") {
    await target.dispatchEvent("pointermove", {
      ...pointer,
      buttons: 1,
      clientX: point.x + 20,
      clientY: point.y,
    })
  } else {
    await target.dispatchEvent("pointercancel", { ...pointer, clientX: point.x, clientY: point.y })
  }
  await target.dispatchEvent("click", { clientX: point.x, clientY: point.y })
}

async function latestSeq(page: Page, channelId: string): Promise<number> {
  const response = await page.request.get(`/api/community/channels/${channelId}/messages`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { latestSeq: number }).latestSeq
}

test("mobile reply, avatar mention, and typing space keep exact backend and WS identity", async ({ asUser }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const serverName = `Mobile-interactions-${stamp}`
  const serverId = await seedServer("alice", serverName)
  const channelId = await seedChannel("alice", serverId, "mobile-interactions")
  await seedJoinServer("alice", "bob", serverId)
  const channelBobMessageId = await seedMessage("bob", channelId, `channel **target** ${stamp}`)
  const channelBobSecondMessageId = await seedMessage("bob", channelId, `channel _alternate_ ${stamp}`)
  await seedMessage("alice", channelId, Array.from(
    { length: 80 },
    (_, index) => `scroll restoration line ${index} ${stamp}`,
  ).join("\n\n"))
  const openerId = await seedMessage("alice", channelId, `thread opener ${stamp}`)
  const threadId = await seedThread("alice", openerId, `mobile-thread-${stamp}`)
  const threadBobMessageId = await seedMessage("bob", threadId, `thread **target** ${stamp}`)
  const dmId = await seedDm("alice", userId("bob"))
  const bobInfo = await memberInfo("alice", serverId, userId("bob"))
  const aliceInfo = await memberInfo("alice", serverId, userId("alice"))

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  await installTouchPrimaryPointer(alice.page)
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  const aliceProxy = await proxyCommunityWebSockets(alice.context)
  const bobProxy = await proxyCommunityWebSockets(bob.context)
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await expect(alice.page.getByTestId(tid.message(channelBobMessageId))).toBeVisible()
  const channelWsReadyId = await seedMessage("alice", channelId, `channel ws ready ${stamp}`)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, channelWsReadyId)
  )), { timeout: 20_000 }).toBe(true)

  const channelTarget = alice.page.getByTestId(tid.message(channelBobMessageId))
  const beforeTapSeq = await latestSeq(alice.page, channelId)
  const channelAvatar = channelTarget.getByRole("button", {
    name: `Open ${bobInfo.name} profile; long press to mention`,
  })
  await dispatchCancelledAvatarPress(channelAvatar, "move")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  await dispatchCancelledAvatarPress(channelAvatar, "cancel")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  await channelAvatar.click()
  await expect(alice.page.getByTestId(tid.profileCard)).toBeVisible()
  const mobileProfileSheet = alice.page.locator('[data-slot="sheet-content"][data-side="bottom"]')
  await expect(mobileProfileSheet).toHaveCSS("border-top-width", "0px")
  await alice.page.keyboard.press("Escape")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  const manualMentionEditable = composerEditable(alice.page)
  await manualMentionEditable.click()
  await manualMentionEditable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
  await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
  await expect(manualMentionEditable).toContainText(`@${bobInfo.name}`)
  await manualMentionEditable.fill("")
  expect(await latestSeq(alice.page, channelId)).toBe(beforeTapSeq)

  const beforeRejectedSwipeSeq = await latestSeq(alice.page, channelId)
  const beforeRejectedSwipeFrames = bobProxy.frames.length
  await dispatchSwipePathAndClick(alice.page, channelBobMessageId, [
    { x: 76, y: 1 },
    { x: 0, y: 1 },
  ])
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  await expect(alice.page.getByRole("menuitem")).toHaveCount(0)
  await dispatchSwipePathAndClick(alice.page, channelBobMessageId, [{ x: 32, y: 1 }])
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  await expect(alice.page.getByRole("menuitem")).toHaveCount(0)
  await dispatchSwipe(alice.page, channelBobMessageId, { x: 6, y: 48 })
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  expect(await latestSeq(alice.page, channelId)).toBe(beforeRejectedSwipeSeq)
  expect(bobProxy.frames).toHaveLength(beforeRejectedSwipeFrames)

  await dispatchSwipe(alice.page, channelBobMessageId, { x: 72, y: 2 })
  const replyPreview = alice.page.locator('[data-slot="composer-reply-preview"]')
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · channel target ${stamp}`)
  await alice.page.getByRole("button", { name: "Cancel reply" }).click()
  await expect(replyPreview).toHaveCount(0)
  expect(await latestSeq(alice.page, channelId)).toBe(beforeRejectedSwipeSeq)

  await dispatchSwipe(alice.page, channelBobSecondMessageId, { x: 72, y: 2 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · channel alternate ${stamp}`)
  const replyBody = `swipe reply ${stamp}`
  const replyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  await composerEditable(alice.page).fill(replyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const replyResponse = await replyResponsePromise
  expect(replyResponse.status()).toBe(201)
  const replyPayload = await replyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(replyPayload.message.replyToId).toBe(channelBobSecondMessageId)
  expect(replyPayload.message.content).toContain(replyBody)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, replyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === channelBobSecondMessageId
    ))
  )), { timeout: 20_000 }).toBe(true)
  await expectMessageVisible(bob.page, replyBody)

  await alice.page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
  await bob.page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  const threadTarget = alice.page.getByTestId(tid.message(threadBobMessageId))
  await expect(threadTarget).toBeVisible()
  const restingThreadGap = await alice.page.evaluate(({ targetId, composerId }) => {
    const target = document.querySelector(`[data-testid="${targetId}"]`)?.getBoundingClientRect()
    const composer = document.querySelector(`[data-testid="${composerId}"]`)?.getBoundingClientRect()
    return target && composer ? composer.top - target.bottom : null
  }, {
    targetId: tid.message(threadBobMessageId),
    composerId: tid.channelComposerShell,
  })
  expect(restingThreadGap).not.toBeNull()
  expect(restingThreadGap!).toBeGreaterThanOrEqual(0)
  expect(restingThreadGap!).toBeLessThanOrEqual(40)
  const threadWsReadyId = await seedMessage("alice", threadId, `thread ws ready ${stamp}`)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, threadWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  const editable = composerEditable(alice.page)
  await editable.fill("openerhere")
  await editable.click()
  for (let index = 0; index < 4; index += 1) await alice.page.keyboard.press("ArrowLeft")
  await dispatchLongPress(
    alice.page,
    alice.page.locator("[data-thread-opener]").getByRole("button", {
      name: `Open ${aliceInfo.name} profile; long press to mention`,
    }),
  )
  await expect(editable).toHaveText(`opener @${aliceInfo.name} here`)
  await expect(editable.locator(".mention-highlight")).toHaveText(`@${aliceInfo.name}`)

  await editable.fill("helloworld")
  await editable.click()
  for (let index = 0; index < 5; index += 1) await alice.page.keyboard.press("ArrowLeft")
  const avatar = threadTarget.getByRole("button", {
    name: `Open ${bobInfo.name} profile; long press to mention`,
  })
  await dispatchLongPress(alice.page, avatar)
  const mentionBody = `hello @${bobInfo.name}#${bobInfo.discriminator} world`
  await expect(editable).toHaveText(`hello @${bobInfo.name} world`)
  const insertedMention = editable.locator(".mention-highlight")
  await expect(insertedMention).toHaveText(`@${bobInfo.name}`)
  await expect(insertedMention).toHaveAttribute("data-id", bobInfo.id)
  await expect(insertedMention).toHaveAttribute(
    "data-label",
    `${bobInfo.name}#${bobInfo.discriminator}`,
  )

  const mentionResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${threadId}/messages`
  ))
  await alice.page.getByTestId(tid.composerSend).click()
  const mentionResponse = await mentionResponsePromise
  expect(mentionResponse.status()).toBe(201)
  const mentionPayload = await mentionResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(mentionPayload.message).toMatchObject({ content: mentionBody, replyToId: null })
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, mentionPayload.message.id)
    && communityFrameEvents(frame).some((event) => event.type === "community:mention.create")
  )), { timeout: 20_000 }).toBe(true)
  await expect(bob.page.getByTestId(tid.message(mentionPayload.message.id))).toBeVisible()

  await dispatchSwipe(alice.page, threadBobMessageId, { x: 72, y: 1 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · thread target ${stamp}`)
  const threadReplyBody = `thread swipe reply ${stamp}`
  const threadReplyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${threadId}/messages`
  ))
  await composerEditable(alice.page).fill(threadReplyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const threadReplyResponse = await threadReplyResponsePromise
  expect(threadReplyResponse.status()).toBe(201)
  const threadReplyPayload = await threadReplyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(threadReplyPayload.message.replyToId).toBe(threadBobMessageId)
  expect(threadReplyPayload.message.content).toContain(threadReplyBody)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, threadReplyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === threadBobMessageId
    ))
  )), { timeout: 20_000 }).toBe(true)

  await alice.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await bob.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await expect(alice.page.getByTestId(tid.message(replyPayload.message.id))).toBeVisible()
  const typingWsReadyId = await seedMessage("bob", channelId, `typing ws ready ${stamp}`)
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, typingWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  const typingSpace = alice.page.locator("[data-message-typing-space]")
  const spaceBefore = await typingSpace.boundingBox()
  expect(spaceBefore?.height).toBe(0)
  const beforeTypingSeq = await latestSeq(alice.page, channelId)
  const bobEditable = composerEditable(bob.page)
  await expect(async () => {
    await bobEditable.fill("")
    await bobEditable.pressSequentially("typing geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    communityFrameEvents(frame).some((event) => (
      event.type === "community:typing.start" && event.channelId === channelId
    ))
  )), { timeout: 20_000 }).toBe(true)

  const geometry = await alice.page.evaluate(({
    scrollerId,
    composerId,
    indicatorId,
    replyMessageTestId,
  }) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${scrollerId}"]`)),
      space: rect(document.querySelector("[data-message-typing-space]")),
      indicator: rect(document.querySelector(`[data-testid="${indicatorId}"]`)),
      composer: rect(document.querySelector(`[data-testid="${composerId}"]`)),
      finalMessage: rect(document.querySelector(`[data-testid="${replyMessageTestId}"]`)),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, {
    scrollerId: tid.messageScroller,
    composerId: tid.channelComposerShell,
    indicatorId: tid.typingIndicator,
    replyMessageTestId: tid.message(replyPayload.message.id),
  })
  expect(geometry.scroller!.bottom).toBeLessThanOrEqual(geometry.space!.top + 1)
  expect(geometry.space!.height).toBe(44)
  expect(geometry.space!.bottom).toBeLessThanOrEqual(geometry.composer!.top + 1)
  expect(geometry.indicator!.top).toBeGreaterThanOrEqual(geometry.space!.top - 1)
  expect(geometry.indicator!.bottom).toBeLessThanOrEqual(geometry.space!.bottom + 1)
  expect(geometry.finalMessage!.bottom).toBeLessThanOrEqual(geometry.scroller!.bottom + 1)
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0)

  const scroller = alice.page.getByTestId(tid.messageScroller)
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  const scrollTypingGeometry = await alice.page.evaluate((ids) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${ids.scroller}"]`)),
      rail: rect(document.querySelector(`[data-testid="${ids.rail}"]`)),
      scroll: rect(document.querySelector(`[data-testid="${ids.scroll}"]`)),
      space: rect(document.querySelector("[data-message-typing-space]")),
      indicator: rect(document.querySelector(`[data-testid="${ids.indicator}"]`)),
    }
  }, {
    scroller: tid.messageScroller,
    rail: tid.composerAccessoryRail,
    scroll: tid.scrollToPresent,
    indicator: tid.typingIndicator,
  })
  expect(scrollTypingGeometry.rail!.bottom).toBeLessThanOrEqual(scrollTypingGeometry.space!.top + 1)
  expect(scrollTypingGeometry.scroll!.bottom).toBeLessThanOrEqual(scrollTypingGeometry.space!.top + 1)
  expect(scrollTypingGeometry.scroll!.bottom).toBeLessThanOrEqual(scrollTypingGeometry.scroller!.bottom + 1)
  expect(scrollTypingGeometry.indicator!.top).toBeGreaterThanOrEqual(scrollTypingGeometry.space!.top - 1)

  await alice.page.getByTestId(tid.scrollToPresent).click()
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await bobEditable.pressSequentially(" selection")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  const finalChannelMessage = alice.page.getByTestId(tid.message(typingWsReadyId))
  await finalChannelMessage.getByText(`typing ws ready ${stamp}`, { exact: true }).click()
  await alice.page.getByRole("menuitem", { name: "Share as Image" }).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  const selectionTypingGeometry = await alice.page.evaluate((ids) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      finalMessage: rect(document.querySelector(`[data-testid="${ids.finalMessage}"]`)),
      scroller: rect(document.querySelector(`[data-testid="${ids.scroller}"]`)),
      rail: rect(document.querySelector(`[data-testid="${ids.rail}"]`)),
      selection: rect(document.querySelector(`[data-testid="${ids.selection}"]`)),
      space: rect(document.querySelector("[data-message-typing-space]")),
      indicator: rect(document.querySelector(`[data-testid="${ids.indicator}"]`)),
      composer: rect(document.querySelector(`[data-testid="${ids.composer}"]`)),
    }
  }, {
    finalMessage: tid.message(typingWsReadyId),
    scroller: tid.messageScroller,
    rail: tid.composerAccessoryRail,
    selection: tid.messageSelectionToolbar,
    indicator: tid.typingIndicator,
    composer: tid.channelComposerShell,
  })
  expect(selectionTypingGeometry.finalMessage!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.rail!.top + 1)
  expect(selectionTypingGeometry.rail!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.space!.top + 1)
  expect(selectionTypingGeometry.selection!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.space!.top + 1)
  expect(selectionTypingGeometry.space!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.composer!.top + 1)
  expect(selectionTypingGeometry.finalMessage!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.scroller!.bottom + 1)
  expect(selectionTypingGeometry.indicator!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.space!.bottom + 1)
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await bobEditable.fill("")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  const spaceAfter = await typingSpace.boundingBox()
  expect(spaceAfter?.height).toBe(0)
  expect(spaceAfter?.y).toBeCloseTo(spaceBefore!.y, 0)
  expect(await latestSeq(alice.page, channelId)).toBe(beforeTypingSeq)

  await alice.page.goto(`/c/me/${dmId}`, { waitUntil: "commit" })
  await bob.page.goto(`/c/me/${dmId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  const dmWsReadyId = await seedMessage("bob", dmId, `dm **reply target** ${stamp}`)
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    frameHasMessage(frame, dmId, dmWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  await expect(alice.page.getByTestId(tid.message(dmWsReadyId))).toBeVisible()
  await dispatchSwipe(alice.page, dmWsReadyId, { x: 72, y: 1 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · dm reply target ${stamp}`)
  await expect(composerEditable(alice.page)).toBeFocused()
  const dmReplyBody = `dm swipe reply ${stamp}`
  const dmReplyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/messages`
  ))
  await composerEditable(alice.page).fill(dmReplyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const dmReplyResponse = await dmReplyResponsePromise
  expect(dmReplyResponse.status()).toBe(201)
  const dmReplyPayload = await dmReplyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(dmReplyPayload.message.replyToId).toBe(dmWsReadyId)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, dmId, dmReplyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === dmWsReadyId
    ))
  )), { timeout: 20_000 }).toBe(true)
  const beforeDmTypingSeq = await latestSeq(alice.page, dmId)
  const dmTypingSpace = alice.page.locator("[data-message-typing-space]")
  const dmSpaceBefore = await dmTypingSpace.boundingBox()
  expect(dmSpaceBefore?.height).toBe(0)
  const bobDmEditable = composerEditable(bob.page)
  await expect(async () => {
    await bobDmEditable.fill("")
    await bobDmEditable.pressSequentially("dm typing geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  const dmGeometry = await alice.page.evaluate(({ scrollerId, indicatorId }) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${scrollerId}"]`)),
      space: rect(document.querySelector("[data-message-typing-space]")),
      indicator: rect(document.querySelector(`[data-testid="${indicatorId}"]`)),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, { scrollerId: tid.messageScroller, indicatorId: tid.typingIndicator })
  expect(dmGeometry.scroller!.bottom).toBeLessThanOrEqual(dmGeometry.space!.top + 1)
  expect(dmGeometry.space!.height).toBe(44)
  expect(dmGeometry.indicator!.bottom).toBeLessThanOrEqual(dmGeometry.space!.bottom + 1)
  expect(dmGeometry.horizontalOverflow).toBeLessThanOrEqual(0)
  await bobDmEditable.fill("")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  expect((await dmTypingSpace.boundingBox())?.height).toBe(0)
  expect(await latestSeq(alice.page, dmId)).toBe(beforeDmTypingSeq)

  await alice.page.emulateMedia({ reducedMotion: "reduce" })
  await alice.page.evaluate(() => {
    const original = Element.prototype.animate
    ;(window as typeof window & { __mobileSurfaceAnimations?: number }).__mobileSurfaceAnimations = 0
    Element.prototype.animate = function (...args) {
      if ((this as HTMLElement).dataset.communityMobileSurface) {
        const state = window as typeof window & { __mobileSurfaceAnimations?: number }
        state.__mobileSurfaceAnimations = (state.__mobileSurfaceAnimations ?? 0) + 1
      }
      return original.apply(this, args)
    }
  })
  await alice.page.getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe("/c/me")
  await alice.page.getByTestId(tid.serverIcon(serverId)).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await alice.page.getByTestId(tid.channelRow(channelId)).evaluate((element) => (
    (element as HTMLElement).click()
  ))
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toBeVisible()
  expect(await alice.page.evaluate(() => (
    window as typeof window & { __mobileSurfaceAnimations?: number }
  ).__mobileSurfaceAnimations)).toBe(0)

  const navigationDraft = `navigation draft ${stamp}`
  const navigationEditable = composerEditable(alice.page)
  await navigationEditable.fill(navigationDraft)
  const readingPosition = await scroller.evaluate((element) => {
    element.scrollTop = Math.min(2200, Math.max(0, element.scrollHeight - element.clientHeight))
    return element.scrollTop
  })
  expect(readingPosition).toBe(2200)
  const getObservationStartedAt = Date.now()
  const channelMessageGets: Array<{ route: string; sinceMs: number; url: string }> = []
  alice.page.on("request", (request) => {
    if (
      request.method() === "GET"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) {
      channelMessageGets.push({
        route: new URL(request.frame().url()).pathname,
        sinceMs: Date.now() - getObservationStartedAt,
        url: request.url(),
      })
    }
  })
  await alice.page.getByRole("button", { name: `Go to server ${serverName}` }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await alice.page.getByTestId(tid.channelRow(channelId)).evaluate((element) => (
    (element as HTMLElement).click()
  ))
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toContainText(navigationDraft)
  await alice.page.waitForTimeout(1600)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0)
  expect(
    channelMessageGets.length,
    `channel message GETs after list return: ${JSON.stringify(channelMessageGets)}`,
  ).toBeLessThanOrEqual(1)
})

test("mobile channel scroll restoration remains stable after navigation settles", async ({ asUser }) => {
  const stamp = Date.now()
  const serverName = `Mobile-scroll-${stamp}`
  const serverId = await seedServer("alice", serverName)
  const channelId = await seedChannel("alice", serverId, "mobile-scroll")
  for (let index = 0; index < 24; index += 1) {
    await seedMessage("alice", channelId, `scroll row ${index} ${stamp}`)
  }
  await seedMessage("alice", channelId, Array.from(
    { length: 95 },
    (_, index) => `scroll line ${index} ${stamp}`,
  ).join("\n\n"))
  const openerId = await seedMessage("alice", channelId, `scroll thread opener ${stamp}`)
  const threadId = await seedThread("alice", openerId, `scroll-thread-${stamp}`)
  const threadReplyId = await seedMessage("alice", threadId, `scroll thread reply ${stamp}`)

  const alice = await asUser("alice")
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await alice.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  const editable = composerEditable(alice.page)
  const scroller = alice.page.getByTestId(tid.messageScroller)
  await expect(editable).toBeVisible()
  await expect.poll(() => scroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThanOrEqual(2200)

  const draft = `stable navigation draft ${stamp}`
  await editable.fill(draft)
  expect(await scroller.evaluate((element) => {
    element.scrollTop = 2200
    return element.scrollTop
  })).toBe(2200)

  await alice.page.getByRole("button", { name: `Go to server ${serverName}` }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await alice.page.getByTestId(tid.channelRow(channelId)).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toContainText(draft)
  await alice.page.waitForTimeout(1600)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(2200, 0)

  await alice.page.getByTestId(tid.scrollToPresent).click()
  const threadIndicator = alice.page.getByTestId(tid.threadIndicator(openerId))
  await expect(threadIndicator).toBeVisible()
  await alice.page.waitForTimeout(500)
  await threadIndicator.focus()
  await expect.poll(async () => {
    const before = await scroller.evaluate((element) => element.scrollTop)
    await alice.page.waitForTimeout(50)
    const after = await scroller.evaluate((element) => element.scrollTop)
    return after - before
  }).toBe(0)
  const channelBackPosition = await scroller.evaluate((element) => element.scrollTop)
  expect(channelBackPosition).toBeGreaterThan(2200)
  await threadIndicator.click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${threadId}`)
  await expect(alice.page.getByTestId(tid.message(threadReplyId))).toBeVisible()
  await alice.page.goBack({ waitUntil: "commit" })
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toContainText(draft)
  await alice.page.waitForTimeout(1600)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(channelBackPosition, 0)
})
