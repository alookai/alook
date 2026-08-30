import type { Page, TestInfo } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { composerEditable, ignoreNextDevToolsPointerCapture } from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
import {
  seedChannel,
  seedDm,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const HOVER_QUERY = "(hover: hover) and (pointer: fine)"

test.use({ viewport: { width: 390, height: 844 } })

async function installInputCapability(page: Page, hoverCapable: boolean) {
  await page.addInitScript(({ query, matches }) => {
    const nativeMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (candidate: string) => candidate === query
      ? {
          matches,
          media: candidate,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList
      : nativeMatchMedia(candidate)
  }, { query: HOVER_QUERY, matches: hoverCapable })
}

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
  await page.goto(route, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(page)

  const editable = composerEditable(page)
  const send = page.getByTestId(tid.composerSend)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await expect(editable).toHaveAttribute("enterkeyhint", "send")
  await expect(send).toHaveCount(0)

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
  await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  expect(messagePosts).toBe(1)
}

async function expectExplicitTouchSend({
  page,
  route,
  channelId,
  label,
  frames,
  exerciseResize = false,
  testInfo,
}: {
  page: Page
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
  await page.goto(route, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(page)

  const editable = composerEditable(page)
  const send = page.getByTestId(tid.composerSend)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await expect(editable).toHaveAttribute("enterkeyhint", "enter")
  await expect(send).toBeVisible()
  await expect(send).toBeDisabled()
  await expect(send).toHaveCSS("width", "32px")
  await expect(send).toHaveCSS("height", "32px")
  await expect(send).toHaveCSS("border-radius", "8px")
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

  await page.getByTestId(tid.composerFileInput).setInputFiles({
    name: `${label}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("pending attachment eligibility"),
  })
  await expect(page.getByRole("button", { name: "Remove file" })).toBeVisible()
  await expect(send).toBeEnabled()
  await page.getByRole("button", { name: "Remove file" }).click()
  await expect(send).toBeDisabled()

  const firstLine = `${label} first ${Date.now()}`
  const secondLine = `${label} second`
  await editable.click()
  await editable.pressSequentially(firstLine)
  await page.keyboard.press("Enter")
  await editable.pressSequentially(secondLine)
  await expect(editable.locator("p")).toHaveCount(2)
  await expect(editable).toContainText(firstLine)
  await expect(editable).toContainText(secondLine)
  await expect(send).toBeEnabled()
  await expect(send).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
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
  await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(tid.message(payload.message.id))).toContainText(firstLine)
  expect(messagePosts).toBe(1)
}

test.describe.serial("composer send by input capability", () => {
  let serverId: string
  let channelId: string
  let threadId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `capability-send-${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "capability-send")
    const openerId = await seedMessage("alice", channelId, "capability send thread opener")
    threadId = await seedThread("alice", openerId, "capability-send-thread")
    dmId = await seedDm("alice", userId("bob"))
  })

  test("narrow hover-capable PC keeps Enter send and Shift+Enter newline through resize", async ({ asUser }) => {
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

  test("touch channel keeps multiline Enter and the explicit button sends once", async ({ asUser }, testInfo) => {
    const { page, context } = await asUser("alice")
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

  test("touch child thread button targets the child", async ({ asUser }) => {
    const { page, context } = await asUser("alice")
    await installInputCapability(page, false)
    const proxy = await proxyCommunityWebSockets(context)
    await expectExplicitTouchSend({
      page,
      route: `/c/channels/${serverId}/${threadId}`,
      channelId: threadId,
      label: "thread",
      frames: proxy.frames,
    })
  })

  test("touch DM button targets the DM channel", async ({ asUser }) => {
    const { page, context } = await asUser("alice")
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
