import { test, expect, userId } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import {
  seedServer,
  seedChannel,
  seedDm,
  seedMark,
  seedMessage,
  seedThread,
} from "./_fixtures/seed"

// Journey 8 — adaptive list/detail routing. At <640px semantic roots render
// lists and leaf paths render detail. Header Back replaces with the parent.
test.use({ viewport: { width: 390, height: 844 } })

test.describe.serial("mobile layout", () => {
  let serverId: string
  let channelId: string
  let childChannelId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Mobile ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "mobile-chan")
    const parentMessageId = await seedMessage("alice", channelId, "mobile seq command target")
    childChannelId = await seedThread("alice", parentMessageId, "mobile-child")
    const childMessageId = await seedMessage("alice", childChannelId, "mobile child seq target")
    await seedMark("alice", childChannelId, childMessageId)
    dmId = await seedDm("alice", userId("bob"))
  })

  test("a direct channel opens detail and Header Back replaces it with the server root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await page.waitForURL(new RegExp(channelId), { timeout: 20_000 , waitUntil: "commit" })

    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    const back = page.getByRole("button", { name: "Back" })
    await expect(back).toBeVisible()

    const historyLength = await page.evaluate(() => history.length)
    await back.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    await page.reload()
    await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("browser Back and Forward restore list and detail from semantic paths", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    const channelRow = page.getByTestId(tid.channelRow(channelId))
    await expect(channelRow).toBeVisible()

    await channelRow.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(channelRow).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()

    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("Friends, Machines, and Bots deep links all default to content", async ({ asUser }) => {
    const { page } = await asUser("alice")

    for (const pathname of ["/c/me/friends", "/c/me/machines", "/c/me/bots"]) {
      await page.goto(pathname)
      const back = page.getByRole("button", { name: "Back" })
      await expect(back).toBeVisible()
      await expect(page.getByTestId(tid.homeButton)).toBeHidden()

      await back.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
      expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
      await expect(page.getByTestId(tid.homeButton)).toBeVisible()
    }
  })

  test("detail consumes seq without dropping other URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}?seq=1&keep=detail-seq`)

    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("detail-seq")
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("canonical child detail consumes seq without dropping route or other URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(
      `/c/channels/${serverId}/${channelId}/${childChannelId}?seq=1&keep=child-seq`,
    )

    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${channelId}/${childChannelId}`,
    )
    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    expect(new URL(page.url()).searchParams.get("keep")).toBe("child-seq")
    await expect(page.getByRole("dialog").getByText("mobile child seq target")).toBeVisible()
  })

  test("Marked opens a child message on its canonical route without losing context", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c/me")
    await page.getByRole("button", { name: "Inbox" }).click()
    await page.getByRole("tab", { name: "Marked" }).click()
    await page.getByText("mobile child seq target", { exact: true }).click()

    await expect.poll(() => new URL(page.url()).pathname).toBe(
      `/c/channels/${serverId}/${channelId}/${childChannelId}`,
    )
    await expect.poll(() => new URL(page.url()).searchParams.has("seq")).toBe(false)
    await expect(page.getByRole("dialog").getByText("mobile child seq target")).toBeVisible()
  })

  test("server-root modal markers are one-shot on mobile", async ({ asUser }) => {
    for (const marker of ["settings", "invite"]) {
      const { page } = await asUser("alice")
      await page.goto(`/c/channels/${serverId}?${marker}=1&keep=${marker}`)

      if (marker === "settings") {
        await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
        await page.getByTestId(tid.settingsClose).click()
        await expect(page.getByTestId(tid.settingsShell)).toBeHidden()
      } else {
        const inviteDialog = page.getByRole("dialog")
        await expect(inviteDialog).toBeVisible()
        await expect(inviteDialog.getByText(/^Invite friends to Mobile-/)).toBeVisible()
        await inviteDialog.getByRole("button", { name: "Close" }).click()
        await expect(inviteDialog).toBeHidden()
      }

      await expect.poll(() => new URL(page.url()).pathname).toBe(
        `/c/channels/${serverId}`,
      )
      await expect.poll(() => new URL(page.url()).searchParams.has(marker)).toBe(false)
      expect(new URL(page.url()).searchParams.get("keep")).toBe(marker)

      await page.reload()
      expect(new URL(page.url()).searchParams.has(marker)).toBe(false)
      await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
      if (marker === "settings") {
        await expect(page.getByTestId(tid.settingsShell)).toBeHidden()
      } else {
        await expect(page.getByRole("dialog")).toBeHidden()
      }
      await page.close()
    }
  })

  test("a direct DM opens detail and Header Back replaces it with Me root", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeHidden()
  })

  test("cross-layout Back and Forward restore each route-owned surface", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.homeButton)).toBeVisible()

    await page.getByTestId(tid.homeButton).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    await page.getByTestId(tid.dmRow(dmId)).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe("/c/me")
    await expect(page.getByTestId(tid.dmRow(dmId))).toBeVisible()

    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()

    await page.goForward()
    await page.goForward()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/me/${dmId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  })

  test("resizing resolves desktop roots to detail without inventing layout URL state", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    await page.getByRole("button", { name: "Back" }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()

    await page.setViewportSize({ width: 900, height: 844 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId(tid.composerInput)).toBeVisible()
    expect(new URL(page.url()).searchParams.has("pane")).toBe(false)
  })
})
