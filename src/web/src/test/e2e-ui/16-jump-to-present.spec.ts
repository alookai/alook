import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

test("anchored channel jumps to the newest tail with one request", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Jump Present ${Date.now()}`)
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  const channelId = await seedChannel("alice", serverId, `jump-present-${Date.now()}`)
  const anchorId = await seedMessage("alice", channelId, "jump anchor")
  let latestId = ""
  for (let index = 1; index <= 36; index++) {
    latestId = await seedMessage(index % 2 === 0 ? "bob" : "carol", channelId, `newer message ${index}`)
  }
  const readResponse = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: anchorId }),
  })
  expect(readResponse.ok).toBe(true)

  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await expect(page.getByTestId(tid.message(anchorId))).toBeVisible({ timeout: 30_000 })
  const jumpButton = page.getByRole("button", { name: /^Jump to present, \d+ unread below$/ })
  await expect(jumpButton).toBeVisible({ timeout: 20_000 })

  let newestGets = 0
  let anchorGets = 0
  page.on("request", (request) => {
    if (request.method() !== "GET") return
    const url = new URL(request.url())
    if (url.pathname !== `/api/community/channels/${channelId}/messages`) return
    if (url.search === "") newestGets += 1
    if (url.searchParams.has("anchor")) anchorGets += 1
  })

  await jumpButton.click()
  await expect(page.getByTestId(tid.message(latestId))).toBeVisible({ timeout: 30_000 })
  await expect(jumpButton).toBeHidden()
  await expect(page.getByText("Loading newer messages…", { exact: true })).toHaveCount(0)
  await expect.poll(() => newestGets).toBe(1)
  await page.waitForTimeout(1_000)
  expect(newestGets).toBe(1)
  expect(anchorGets).toBe(0)
})
