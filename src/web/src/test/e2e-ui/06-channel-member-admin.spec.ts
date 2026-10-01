import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel, seedJoinServer, seedCategory, seedMessage, seedThread } from "./_fixtures/seed"

// Journey 6 — channel / member administration + the eject branch (needs a
// second identity). Focuses on member list presence and non-member ejection.
test.describe.serial("channel & member admin", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Admin ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "admin-chan")
    await seedJoinServer("alice", "bob", serverId)
  })

  test("a non-member is ejected when hitting the server URL directly", async ({ asUser }) => {
    // Carol is not a member of Alice's server.
    const { page } = await asUser("carol")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    // She's redirected away from the server she can't access.
    await expect(page).not.toHaveURL(new RegExp(`/channels/${serverId}/${channelId}$`), { timeout: 20_000 })
  })

  test("the member list shows server members", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })
    // Open the members panel via the channel header.
    await page.getByRole("button", { name: /member/i }).first().click()
    await expect(page.getByTestId(tid.memberRow(userId("bob")))).toBeVisible({ timeout: 15_000 })
  })

  test("Channels loads only on selection and lists private metadata without granting content access", async ({ asUser }) => {
    const categoryId = await seedCategory("alice", serverId, `Directory QA ${Date.now()}`, { private: true })
    const privateId = await seedChannel("bob", serverId, "bob-private", "forum", categoryId)
    const root = await seedMessage("alice", channelId, "Thread root")
    const childId = await seedThread("alice", root, "Child excluded")
    const { page } = await asUser("alice")
    const adminPath = `/api/community/servers/${serverId}/channels/admin`
    const requests: string[] = []
    const responses: number[] = []
    let abortedRequests = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === adminPath) requests.push(request.url())
    })
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === adminPath) responses.push(response.status())
    })
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === adminPath && request.failure()?.errorText === "net::ERR_ABORTED") abortedRequests += 1
    })
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    expect(requests).toHaveLength(0)
    await page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
    await page.getByTestId(tid.serverSettingsOpen).click()
    await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
    expect(requests).toHaveLength(0)
    const response = page.waitForResponse((res) => new URL(res.url()).pathname === adminPath)
    await page.getByTestId(tid.settingsTab("channels")).click()
    const result = await response
    expect(result.status()).toBe(200)
    const data = await result.json() as { channels: { id: string; creator: { handle: string } | null; createdAt: string }[] }
    expect(data.channels.map((row) => row.id)).toContain(privateId)
    expect(data.channels.map((row) => row.id)).not.toContain(childId)
    const row = page.getByTestId(tid.settingsChannel(privateId))
    await expect(row).toBeVisible()
    await expect(row).toContainText("bob-private")
    await expect(row).toContainText(`@${data.channels.find((channel) => channel.id === privateId)!.creator!.handle}`)
    await expect(row.locator("time")).toHaveAttribute("datetime", data.channels.find((channel) => channel.id === privateId)!.createdAt)
    await expect(row.getByRole("link")).toHaveCount(0)
    expect(responses).toEqual([200])
    await expect.poll(() => requests.length - abortedRequests).toBe(1)
    const messages = await page.request.get(`/api/community/channels/${privateId}/messages`)
    expect(messages.status()).toBe(403)
    await page.getByTestId(tid.settingsClose).click()
    await expect(page.getByTestId(tid.channelRow(privateId))).toHaveCount(0)
  })

  test("ordinary members have no settings entry or admin list access", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
    await expect(page.getByTestId(tid.serverSettingsOpen)).toHaveCount(0)
    await expect(page.getByTestId(tid.settingsTab("channels"))).toHaveCount(0)
    const result = await page.request.get(`/api/community/servers/${serverId}/channels/admin`)
    expect(result.status()).toBe(403)
  })
})
