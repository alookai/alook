import type { Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { composerEditable } from "./_fixtures/actions"
import {
  seedChannel,
  seedDm,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

test.use({ viewport: { width: 390, height: 844 } })

async function expectExplicitMobileSend({
  page,
  route,
  channelId,
  label,
  exerciseResize = false,
}: {
  page: Page
  route: string
  channelId: string
  label: string
  exerciseResize?: boolean
}) {
  let messagePosts = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) messagePosts += 1
  })
  await page.goto(route, { waitUntil: "commit" })
  await page.addStyleTag({
    content: [
      "nextjs-portal { pointer-events: none !important; }",
      ".tsqd-parent-container { pointer-events: none !important; }",
    ].join("\n"),
  })

  const editable = composerEditable(page)
  const send = page.getByTestId(tid.composerSend)
  await expect(editable).toBeVisible({ timeout: 20_000 })
  await expect(editable).toHaveAttribute("enterkeyhint", "enter")
  await expect(send).toBeVisible()
  await expect(send).toBeDisabled()

  if (exerciseResize) {
    await editable.evaluate((element) => {
      ;(element as HTMLElement).dataset.e2eEditorIdentity = "stable"
    })
    await page.setViewportSize({ width: 640, height: 844 })
    await expect(editable).toHaveAttribute("data-e2e-editor-identity", "stable")
    await expect(editable).toHaveAttribute("enterkeyhint", "send")
    await expect(send).toBeHidden()
    await page.setViewportSize({ width: 639, height: 844 })
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
  expect(messagePosts).toBe(0)
  await expect(page.locator("[data-msg-id]").filter({ hasText: firstLine })).toHaveCount(0)

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
}

test.describe.serial("mobile composer explicit send", () => {
  let serverId: string
  let channelId: string
  let threadId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `mobile-send-${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mobile-send")
    const openerId = await seedMessage("alice", channelId, "mobile send thread opener")
    threadId = await seedThread("alice", openerId, "mobile-send-thread")
    dmId = await seedDm("alice", userId("bob"))
  })

  test("text channel Enter stays multiline and the button sends once", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await expectExplicitMobileSend({
      page,
      route: `/c/channels/${serverId}/${channelId}`,
      channelId,
      label: "channel",
      exerciseResize: true,
    })
  })

  test("child thread Enter stays multiline and the button targets the child", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await expectExplicitMobileSend({
      page,
      route: `/c/channels/${serverId}/${threadId}`,
      channelId: threadId,
      label: "thread",
    })
  })

  test("DM Enter stays multiline and the button targets the DM channel", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await expectExplicitMobileSend({
      page,
      route: `/c/me/${dmId}`,
      channelId: dmId,
      label: "dm",
    })
  })
})
