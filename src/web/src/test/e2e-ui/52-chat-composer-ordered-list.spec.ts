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

type MessageResponse = {
  message: { id: string; channelId: string; content: string }
}

function createdMessage(
  frames: CapturedCommunityFrame[],
  channelId: string,
  messageId: string,
) {
  return frames.flatMap(communityFrameEvents).find((event) => (
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.id === messageId
  ))
}

async function expectExactMessageCommit({
  page,
  channelId,
  content,
  frames,
  submit,
}: {
  page: Page
  channelId: string
  content: string
  frames: CapturedCommunityFrame[]
  submit: () => Promise<void>
}) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  await submit()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({ content })
  const payload = await response.json() as MessageResponse
  expect(payload.message).toMatchObject({ channelId, content })
  await expect(page.getByTestId(tid.message(payload.message.id))).toBeVisible()
  await expect.poll(() => createdMessage(frames, channelId, payload.message.id)?.message?.content)
    .toBe(content)
  return payload.message.id
}

async function typeCanonicalMarker(
  page: Page,
  start: number,
  text: string,
  root: Page | Locator = page,
) {
  const editable = composerEditable(page, root)
  await editable.click()
  await editable.pressSequentially(`${start}. ${text}`)
  await expect(editable.locator("ol")).toHaveCount(1)
  if (start !== 1) await expect(editable.locator("ol")).toHaveAttribute("start", String(start))
  return editable
}

test.describe("chat composer ordered-list continuation", () => {
  async function prepareCase1(actors: CaseActors) {
    const { userId } = actors
    const { seedChannel, seedDm, seedMessage, seedServer, seedThread } = actors.seed
    const serverId: string = await seedServer("alice", `composer-lists-${Date.now()}`)
    const channelAId: string = await seedChannel("alice", serverId, "composer-lists-a")
    const channelBId: string = await seedChannel("alice", serverId, "composer-lists-b")
    const forumId: string = await seedChannel("alice", serverId, "composer-lists-forum", "forum")
    const openerId = await seedMessage("alice", channelAId, "ordered-list thread opener")
    const threadId: string = await seedThread("alice", openerId, "ordered-list-thread")
    const dmId: string = await seedDm("alice", userId("bob"))
    return { serverId, channelAId, channelBId, forumId, threadId, dmId }
  }

  test("desktop nests with official list keys and commits exact numbered text", async ({ caseActors }, testInfo: TestInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelAId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice")
    await installInputCapability(page, true)
    const proxy = await proxyCommunityWebSockets(context)
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelAId}`)
    await ignoreNextDevToolsPointerCapture(page)

    const editable = await typeCanonicalMarker(page, 9, "parent")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.press("Tab")
    await editable.pressSequentially("child")
    await page.keyboard.press("Shift+Enter")
    await editable.pressSequentially("next")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.press("Shift+Tab")
    await editable.pressSequentially("sibling")

    const topLevelItems = editable.locator(":scope > ol > li")
    await expect(topLevelItems).toHaveCount(2)
    await expect(topLevelItems.first().locator(":scope > ol > li")).toHaveCount(2)
    await expect(editable).toHaveAttribute("enterkeyhint", "send")
    await editable.evaluate((element) => {
      ;(element as HTMLElement).dataset.e2eEditorIdentity = "ordered-list-editor"
    })
    await page.setViewportSize({ width: 639, height: 844 })
    await expect(editable).toHaveAttribute("data-e2e-editor-identity", "ordered-list-editor")
    await expect(editable).toHaveAttribute("enterkeyhint", "send")
    await page.setViewportSize({ width: 640, height: 844 })
    await expect(editable).toHaveAttribute("data-e2e-editor-identity", "ordered-list-editor")

    await testInfo.attach("ordered-list-desktop-nested.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    const content = "9. parent\n   1. child\n   2. next\n10. sibling"
    const messageId = await expectExactMessageCommit({
      page,
      channelId: channelAId,
      content,
      frames: proxy.frames,
      submit: async () => { await page.keyboard.press("Enter") },
    })
    await expect(editable).toHaveText("")
    await page.reload({ waitUntil: "commit" })
    await expect(page.getByTestId(tid.message(messageId))).toContainText("parent")
    await expect(page.getByTestId(tid.message(messageId))).toContainText("sibling")
  })

  test("touch Enter continues and exits while only the send button commits", async ({ caseActors }, testInfo: TestInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelAId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice", { viewport: { width: 390, height: 844 } })
    await installInputCapability(page, false)
    const proxy = await proxyCommunityWebSockets(context)
    let posts = 0
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/community/channels/${channelAId}/messages`
      ) posts += 1
    })
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelAId}`)
    await ignoreNextDevToolsPointerCapture(page)

    const editable = await typeCanonicalMarker(page, 9, "first")
    const send = page.getByTestId(tid.composerSend)
    await expect(editable).toHaveAttribute("enterkeyhint", "enter")
    await expect(send).toBeVisible()
    await page.keyboard.press("Enter")
    await editable.pressSequentially("second")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await editable.pressSequentially("tail")
    await expect(editable.locator(":scope > ol > li")).toHaveCount(2)
    await expect(editable.locator(":scope > p").filter({ hasText: "tail" })).toHaveCount(1)
    expect(posts).toBe(0)

    await testInfo.attach("ordered-list-touch-exit.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    await expectExactMessageCommit({
      page,
      channelId: channelAId,
      content: "9. first\n10. second\n\ntail",
      frames: proxy.frames,
      submit: async () => { await send.click() },
    })
    expect(posts).toBe(1)
  })

  test("child thread and DM commits stay in their exact channel scope", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, threadId, dmId } = await prepareCase1(actors)

    const { page, context } = await asUser("alice")
    await installInputCapability(page, true)
    const proxy = await proxyCommunityWebSockets(context)
    const routes = [
      { route: `/c/channels/${serverId}/${threadId}`, channelId: threadId, start: 42 },
      { route: `/c/me/${dmId}`, channelId: dmId, start: 7 },
    ]

    for (const { route, channelId, start } of routes) {
      await gotoAfterUserWsAuth(page, route)
      const root = channelId === threadId ? page.getByTestId(tid.threadSplitPanel) : page
      const editable = await typeCanonicalMarker(page, start, "first", root)
      await page.keyboard.press("Shift+Enter")
      await editable.pressSequentially("second")
      await expectExactMessageCommit({
        page,
        channelId,
        content: `${start}. first\n${start + 1}. second`,
        frames: proxy.frames,
        submit: async () => { await page.keyboard.press("Enter") },
      })
    }
  })

  test("draft, undo, IME, plain paste, and forum-body boundaries remain stable", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelAId, channelBId, forumId } = await prepareCase1(actors)

    const { page } = await asUser("alice")
    await installInputCapability(page, true)
    let messagePosts = 0
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/messages")) {
        messagePosts += 1
      }
    })
    await page.goto(`/c/channels/${serverId}/${channelAId}`, { waitUntil: "commit" })
    let editable = await typeCanonicalMarker(page, 42, "draft")
    await page.keyboard.press("Shift+Enter")
    await editable.pressSequentially("restored")
    await page.goto(`/c/channels/${serverId}/${channelBId}`, { waitUntil: "commit" })
    await expect(composerEditable(page)).toHaveText("")
    await page.goto(`/c/channels/${serverId}/${channelAId}`, { waitUntil: "commit" })
    editable = composerEditable(page)
    await expect(editable.locator("ol")).toHaveAttribute("start", "42")
    await expect(editable.locator("li")).toHaveCount(2)

    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("7. ")
    await expect(editable.locator("ol")).toHaveCount(1)
    await editable.press("ControlOrMeta+Z")
    await expect(editable.locator("ol")).toHaveCount(0)
    await expect(editable).toHaveText("7. ")
    await editable.pressSequentially("plain")
    await editable.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }))
    })
    await expect(editable).toHaveText("7. plain")
    expect(messagePosts).toBe(0)

    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.evaluate((element) => {
      const transfer = new DataTransfer()
      transfer.setData("text/plain", "1. alpha\n2. beta")
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }))
    })
    await expect(editable.locator("ol")).toHaveCount(0)
    await expect(editable).toContainText("1. alpha")
    await expect(editable).toContainText("2. beta")
    expect(messagePosts).toBe(0)

    await editable.press("ControlOrMeta+A")
    await editable.press("Backspace")
    await editable.pressSequentially("5. exit")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.press("Shift+Enter")
    await expect(editable.locator(":scope > ol > li")).toHaveCount(1)
    await expect(editable.locator(":scope > ol > li br")).toHaveCount(0)
    await expect(editable.locator(":scope > p")).toHaveCount(1)
    expect(messagePosts).toBe(0)

    await page.goto(`/c/channels/${serverId}/${forumId}`, { waitUntil: "commit" })
    await page.getByRole("button", { name: "New Post" }).click()
    const forumBody = composerEditable(page)
    await expect(forumBody).toBeVisible()
    await forumBody.pressSequentially("1. literal forum body")
    await expect(forumBody.locator("ol")).toHaveCount(0)
    await expect(forumBody).toHaveText("1. literal forum body")
    expect(messagePosts).toBe(0)
  })
})
