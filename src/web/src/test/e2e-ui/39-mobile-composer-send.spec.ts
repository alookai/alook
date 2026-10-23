import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import {
  composerEditable,
  gotoAfterUserWsAuth,
  ignoreNextDevToolsPointerCapture,
  installInputCapability,
} from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

test.use({ viewport: { width: 390, height: 844 } })

function hasMessageFrame(
  frames: CapturedCommunityFrame[],
  channelId: string,
  messageId: string,
) {
  return frames.flatMap(communityFrameEvents).some((event) => (
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.id === messageId
  ))
}

async function expectHoverKeyboardSend({
  page,
  route,
  channelId,
  frames,
}: {
  page: Page
  route: string
  channelId: string
  frames: CapturedCommunityFrame[]
}) {
  let messagePosts = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) messagePosts += 1
  })
  await gotoAfterUserWsAuth(page, route)
  await ignoreNextDevToolsPointerCapture(page)

  const editable = composerEditable(page)
  const send = page.getByTestId(tid.composerSend)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await expect(editable).toHaveAttribute("enterkeyhint", "send")
  await expect(send).toHaveCount(0)
  await expect(page.getByTestId(tid.composerInput).locator("..").getByRole("button", { name: "Emoji picker" })).toBeVisible()

  await editable.evaluate((element) => {
    ;(element as HTMLElement).dataset.e2eEditorIdentity = "stable"
  })
  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(editable).toHaveAttribute("data-e2e-editor-identity", "stable")
  await expect(editable).toHaveAttribute("enterkeyhint", "send")
  await expect(send).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(editable).toHaveAttribute("data-e2e-editor-identity", "stable")
  await expect(editable).toHaveAttribute("enterkeyhint", "send")
  await expect(send).toHaveCount(0)

  const firstLine = `narrow PC first ${Date.now()}`
  const secondLine = "narrow PC second"
  await editable.click()
  await editable.pressSequentially(firstLine)
  await page.keyboard.press("Shift+Enter")
  await editable.pressSequentially(secondLine)
  await expect(editable.locator("br")).toHaveCount(1)
  await expect(editable).toContainText(firstLine)
  await expect(editable).toContainText(secondLine)
  expect(messagePosts).toBe(0)

  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  await page.keyboard.press("Enter")
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const payload = await response.json() as { message: { id: string } }
  await expect(page.getByTestId(tid.message(payload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(secondLine)
  await expect(editable).toHaveText("")
  expect(messagePosts).toBe(1)
  await expect.poll(() => hasMessageFrame(frames, channelId, payload.message.id)).toBe(true)

  await page.reload({ waitUntil: "commit" })
  const reloadedComposer = composerEditable(page)
  await expect(async () => {
    expect(await reloadedComposer.count()).toBe(1)
    expect(await reloadedComposer.isVisible()).toBe(true)
  }).toPass({ timeout: 20_000 })
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  expect(messagePosts).toBe(1)
}

async function expectExplicitTouchSend({
  page,
  root = page,
  parentRoot,
  route,
  channelId,
  label,
  frames,
  exerciseResize = false,
  testInfo,
}: {
  page: Page
  root?: Page | Locator
  parentRoot?: Locator
  route: string
  channelId: string
  label: string
  frames: CapturedCommunityFrame[]
  exerciseResize?: boolean
  testInfo?: TestInfo
}) {
  let messagePosts = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) messagePosts += 1
  })
  await gotoAfterUserWsAuth(page, route)
  await ignoreNextDevToolsPointerCapture(page)

  const editable = composerEditable(page, root)
  const send = root.getByTestId(tid.composerSend)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await expect(editable).toHaveAttribute("enterkeyhint", "enter")
  await expect(send).toBeVisible()
  await expect(send).toBeDisabled()
  await expect(send).toHaveCSS("width", "44px")
  await expect(send).toHaveCSS("height", "44px")
  await expect.poll(() => send.evaluate((button) => {
    const size = button.getBoundingClientRect()
    return Number.parseFloat(getComputedStyle(button).borderRadius) >= size.width / 2
  })).toBe(true)
  const composer = root.getByTestId(tid.composerInput).locator("..")
  await expect(composer).toHaveCSS("border-radius", "24px")
  await expect(composer.getByRole("button", { name: "Emoji picker" })).toHaveCount(0)
  const singleLineHeight = await composer.evaluate((element) => element.getBoundingClientRect().height)
  await expect(send).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(send.locator("svg")).toHaveAttribute("viewBox", "0 0 24 24")

  if (testInfo) {
    await testInfo.attach("390-touch-send-disabled.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  }

  if (exerciseResize) {
    await editable.evaluate((element) => {
      ;(element as HTMLElement).dataset.e2eEditorIdentity = "stable"
    })
    await page.setViewportSize({ width: 1280, height: 844 })
    await expect(editable).toHaveAttribute("data-e2e-editor-identity", "stable")
    await expect(editable).toHaveAttribute("enterkeyhint", "enter")
    await expect(send).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(editable).toHaveAttribute("data-e2e-editor-identity", "stable")
    await expect(editable).toHaveAttribute("enterkeyhint", "enter")
    await expect(send).toBeVisible()
  }

  if (parentRoot) {
    await expect(parentRoot).toHaveCount(0)
    await expect(root.getByTestId(tid.composerFileInput)).toHaveCount(1)
    await expect(page.getByTestId(tid.composerFileInput)).toHaveCount(2)
    await expect.poll(() => page.getByTestId(tid.composerFileInput).evaluateAll(inputs => (
      inputs.filter(input => input.closest('[data-mobile-page-active="false"][inert][aria-hidden="true"]')).length
    ))).toBe(1)
  }

  await root.getByTestId(tid.composerFileInput).setInputFiles({
    name: `${label}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("pending attachment eligibility"),
  })
  await expect(root.getByRole("button", { name: "Remove file" })).toBeVisible()
  await expect(send).toBeEnabled()
  await root.getByRole("button", { name: "Remove file" }).click()
  await expect(send).toBeDisabled()

  const firstLine = `${label} first ${Date.now()}`
  const secondLine = `${label} second`
  await editable.click()
  await editable.pressSequentially(firstLine)
  await page.keyboard.press("Enter")
  await editable.pressSequentially(secondLine)
  await expect(editable.locator("p")).toHaveCount(2)
  await expect(composer).toHaveCSS("border-radius", "24px")
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(singleLineHeight)
  await expect(editable).toContainText(firstLine)
  await expect(editable).toContainText(secondLine)
  await expect(send).toBeEnabled()
  await expect(send).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(send).toHaveCSS("width", "56px")
  await expect(send).toHaveCSS("height", "44px")
  await expect(send).toHaveCSS("border-right-width", "2px")
  await expect(send.locator("svg")).toHaveCSS("width", "24px")
  expect(messagePosts).toBe(0)
  await expect(page.locator("[data-msg-id]").filter({ hasText: firstLine })).toHaveCount(0)

  if (testInfo) {
    await testInfo.attach("390-touch-send-active.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  }

  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  await send.evaluate((button) => {
    const sendButton = button as HTMLButtonElement
    sendButton.click()
    sendButton.click()
  })
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const payload = await response.json() as { message: { id: string } }
  await expect(page.getByTestId(tid.message(payload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(secondLine)
  await expect(editable).toHaveText("")
  await expect(send).toBeDisabled()
  expect(messagePosts).toBe(1)
  await expect.poll(() => hasMessageFrame(frames, channelId, payload.message.id)).toBe(true)

  await page.reload({ waitUntil: "commit" })
  const reloadedComposer = composerEditable(page, root)
  await expect(async () => {
    expect(await reloadedComposer.count()).toBe(1)
    expect(await reloadedComposer.isVisible()).toBe(true)
  }).toPass({ timeout: 20_000 })
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  expect(messagePosts).toBe(1)
}

test.describe("composer send by input capability", () => {
  async function prepareCase1(actors: CaseActors) {
    const { userId } = actors
    const { seedChannel, seedDm, seedMessage, seedServer, seedThread } = actors.seed
    const serverId: string = await seedServer("alice", `capability-send-${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "capability-send")
    const openerId = await seedMessage("alice", channelId, "capability send thread opener")
    const threadId: string = await seedThread("alice", openerId, "capability-send-thread")
    const dmId: string = await seedDm("alice", userId("bob"))
    return { serverId, channelId, threadId, dmId }
  }

  test("narrow hover-capable PC keeps Enter send and Shift+Enter newline through resize", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice")
    await installInputCapability(page, true)
    const proxy = await proxyCommunityWebSockets(context)
    await expectHoverKeyboardSend({
      page,
      route: `/c/channels/${serverId}/${channelId}`,
      channelId,
      frames: proxy.frames,
    })
  })

  test("touch channel keeps multiline Enter and the explicit button sends once", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice", { hasTouch: true })
    await installInputCapability(page, false)
    const proxy = await proxyCommunityWebSockets(context)
    await expectExplicitTouchSend({
      page,
      route: `/c/channels/${serverId}/${channelId}`,
      channelId,
      label: "channel",
      frames: proxy.frames,
      exerciseResize: true,
      testInfo,
    })
  })

  test("touch child thread button targets the child", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, threadId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice", { hasTouch: true })
    await installInputCapability(page, false)
    const proxy = await proxyCommunityWebSockets(context)
    await expectExplicitTouchSend({
      page,
      root: page.getByTestId(tid.threadSplitPanel),
      parentRoot: page.getByTestId(tid.threadSplitParent),
      route: `/c/channels/${serverId}/${threadId}`,
      channelId: threadId,
      label: "thread",
      frames: proxy.frames,
    })
  })

  test("touch DM button targets the DM channel", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { dmId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice", { hasTouch: true })
    await installInputCapability(page, false)
    const proxy = await proxyCommunityWebSockets(context)
    await expectExplicitTouchSend({
      page,
      route: `/c/me/${dmId}`,
      channelId: dmId,
      label: "dm",
      frames: proxy.frames,
    })
  })
})
