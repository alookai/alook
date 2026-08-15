import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedServer, seedChannel, seedDm, seedMessage } from "./_fixtures/seed"

// Journey 8 — mobile layout. At <640px the community shell switches zones
// (nav ↔ messages). Opening a channel enters the messages zone; the header
// back button returns to the nav zone.
test.use({ viewport: { width: 390, height: 844 } })

test.describe.serial("mobile layout", () => {
  let serverId: string
  let channelId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Mobile ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mobile-chan")
    await seedMessage("alice", channelId, "mobile seq command target")
    dmId = await seedDm("alice", userId("bob"))
  })

  test("a direct channel opens content and Header Back replaces it with nav", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    // Composer (messages zone) is present.
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    // Mobile header exposes a Back control.
    const back = page.getByRole("button", { name: "Back" })
    await expect(back).toBeVisible()

    const historyLength = await page.evaluate(() => history.length)
    await back.click()
    await expect.poll(() => page.url()).toContain("pane=nav")
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    await page.reload()
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("browser Back and Forward restore nav and content from the URL", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?pane=nav`)
    const channelRow = page.getByTestId(tid.channelRow(channelId))
    await expect(channelRow).toBeVisible()

    await channelRow.click()
    await expect.poll(() => new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
    await expect(channelRow).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()

    await page.goForward()
    await expect.poll(() => new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("Friends, Machines, and Bots deep links all default to content", async ({ asUser }) => {
    const { page } = await asUser("alice")

    for (const pathname of ["/c/me", "/c/me/machines", "/c/me/bots"]) {
      await page.goto(pathname)
      const back = page.getByRole("button", { name: "Back" })
      await expect(back).toBeVisible()
      await expect(page.getByTestId(tid.homeButton)).toBeHidden()

      await back.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(pathname)
      await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
      await expect(page.getByTestId(tid.homeButton)).toBeVisible()
    }
  })

  test("the persistent nav layout consumes seq without dropping other URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?seq=1&keep=nav-seq&pane=nav`)

    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("nav-seq")
    expect(new URL(page.url()).searchParams.get("pane")).toBe("nav")
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
  })

  test("a direct DM opens content and Header Back preserves the resource", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
    expect(new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("cross-layout Back and Forward restore each URL-owned pane", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?pane=nav`)
    await expect(page.getByTestId(tid.homeButton)).toBeVisible()

    await page.getByTestId(tid.homeButton).click()
    await expect.poll(() => new URL(page.url()).pathname.startsWith("/c/me")).toBe(true)
    await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
    await page.getByTestId(tid.dmRow(dmId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname.startsWith("/c/me")).toBe(true)
    await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect.poll(() => new URL(page.url()).searchParams.get("pane")).toBe("nav")
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()

    await page.goForward()
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })
})
