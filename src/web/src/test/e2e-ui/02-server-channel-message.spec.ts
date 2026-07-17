import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { createServer, sendMessage, expectMessageVisible } from "./_fixtures/actions"

// Journey 2 — the core path: create a server, send messages, and exercise the
// message-level edge + regression cases inline. Serial: each step builds on
// the server created in the first test.
test.describe.serial("server → channel → message", () => {
  let serverId: string

  test("create a server from the rail", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c")
    await page.waitForURL(/\/c/, { timeout: 20_000 })
    serverId = await createServer(page, `E2E Server ${Date.now()}`)
    expect(serverId).toBeTruthy()
  })

  test("send a message; it appears and the composer clears", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    await page.waitForURL(/\/c\/channels\/[^/]+\/[^/]+/, { timeout: 20_000 })

    const body = `hello world ${Date.now()}`
    await sendMessage(page, body)
    await expectMessageVisible(page, body)

    // Regression/edge: composer clears after send.
    await expect(page.getByTestId(tid.composerInput)).toHaveText("")
  })

  test("empty message does not send; Shift+Enter inserts a newline", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    await page.waitForURL(/\/c\/channels\/[^/]+\/[^/]+/, { timeout: 20_000 })

    const input = page.getByTestId(tid.composerInput)
    await input.click()
    // Enter on empty input: nothing sent, input stays empty.
    await page.keyboard.press("Enter")
    await expect(input).toHaveText("")

    // Shift+Enter inserts a newline instead of sending.
    await page.keyboard.type("line one")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("line two")
    await expect(input).toContainText("line one")
    await expect(input).toContainText("line two")
  })
})
