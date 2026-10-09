import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel, seedJoinServer, seedCategory, seedMessage, seedThread, memberInfo } from "./_fixtures/seed"

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
    const privateName = "bob-private-channel-with-a-very-long-name-for-mobile-review"
    const privateId = await seedChannel("bob", serverId, privateName, "forum", categoryId)
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
    const membersPanel = page.getByRole("tabpanel", { name: "Members" })
    const expectFiniteMembersFrame = async () => {
      await expect(membersPanel.getByRole("listitem").first()).toBeVisible()
      await expect.poll(() => membersPanel.evaluate((panel) => {
        const content = panel.parentElement!
        const style = getComputedStyle(content)
        const availableHeight = content.clientHeight
          - Number.parseFloat(style.paddingTop)
          - Number.parseFloat(style.paddingBottom)
        const frame = panel.getBoundingClientRect()
        const scrollport = panel.querySelector('[role="listitem"]')!
          .parentElement!.parentElement!
        const scrollFrame = scrollport.getBoundingClientRect()
        return {
          panelFillsContent: availableHeight > 0 && Math.abs(frame.height - availableHeight) <= 1,
          scrollportFillsRemainingFrame: scrollport.clientHeight > 0
            && scrollFrame.top >= frame.top
            && Math.abs(scrollFrame.bottom - frame.bottom) <= 1,
          scrollOwner: getComputedStyle(scrollport).overflowY === "auto",
        }
      })).toEqual({
        panelFillsContent: true,
        scrollportFillsRemainingFrame: true,
        scrollOwner: true,
      })
    }
    await page.getByTestId(tid.settingsTab("members")).click()
    await expectFiniteMembersFrame()
    expect(requests).toHaveLength(0)
    const bob = await memberInfo("alice", serverId, userId("bob"))
    const searchInput = membersPanel.getByPlaceholder("Search members")
    const searchResponse = page.waitForResponse((res) => {
      const url = new URL(res.url())
      return url.pathname === `/api/community/servers/${serverId}/members/search`
        && url.searchParams.get("q") === bob.name
    })
    await searchInput.fill(bob.name)
    const searched = await searchResponse
    expect(searched.status()).toBe(200)
    const searchData = await searched.json() as { members: { id: string; userId: string }[] }
    expect(searchData.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: bob.id, userId: userId("bob") }),
    ]))
    await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
    await expect(searchInput).toHaveValue(bob.name)
    await expect(membersPanel.getByRole("listitem").filter({ hasText: bob.name })
      .getByRole("button", { name: "Member", exact: true })).toBeVisible()
    await searchInput.fill("")
    await expect(searchInput).toHaveValue("")
    await expect(membersPanel.getByRole("listitem").filter({ hasText: "Owner" }).first()).toBeVisible()
    await expectFiniteMembersFrame()
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
    await expect(row).toContainText(privateName)
    await expect(row).toContainText(`@${data.channels.find((channel) => channel.id === privateId)!.creator!.handle}`)
    await expect(row.locator("time")).toHaveAttribute("datetime", data.channels.find((channel) => channel.id === privateId)!.createdAt)
    await expect(row.getByRole("link")).toHaveCount(0)
    expect(responses).toEqual([200])
    await expect.poll(() => requests.length - abortedRequests).toBe(1)
    await page.setViewportSize({ width: 390, height: 844 })
    const label = row.locator(`span[title="${privateName}"]`)
    await expect.poll(async () => label.evaluate((element) => {
      const style = getComputedStyle(element)
      return element.getBoundingClientRect().height > Number.parseFloat(style.lineHeight)
        && element.scrollWidth <= element.clientWidth + 1
        && element.scrollHeight <= element.clientHeight + 1
    })).toBe(true)
    const metadata = row.locator("time").locator("..")
    await expect.poll(async () => metadata.evaluate((element) => {
      const pill = element.querySelector("span[title]")!
      const time = element.querySelector("time")!
      const a = pill.getBoundingClientRect(), b = time.getBoundingClientRect()
      return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 2
        && element.scrollWidth <= element.clientWidth + 1
    })).toBe(true)
    const category = page.getByRole("region", { name: /^Group: Directory QA/ })
    await expect(category.getByLabel("Private group")).toBeVisible()
    const toggle = category.getByRole("button", { name: /^Group: Directory QA/ })
    await toggle.click()
    await expect(row).toHaveCount(0)
    await toggle.click()
    await expect(row).toBeVisible()
    expect(responses).toEqual([200])
    const messages = await page.request.get(`/api/community/channels/${privateId}/messages`)
    expect(messages.status()).toBe(403)
    await page.getByTestId(tid.settingsTab("members")).click()
    await expectFiniteMembersFrame()
    await page.getByTestId(tid.settingsClose).click()
    await expect(page.getByTestId(tid.channelRow(privateId))).toHaveCount(0)
  })

  test("ordinary members cannot open admin settings or access the admin list", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
    await page.getByTestId(tid.serverSettingsOpen).click()
    await expect(page.getByTestId(tid.settingsShell)).toHaveCount(0)
    await expect(page.getByTestId(tid.settingsTab("channels"))).toHaveCount(0)
    const result = await page.request.get(`/api/community/servers/${serverId}/channels/admin`)
    expect(result.status()).toBe(403)
  })
})
