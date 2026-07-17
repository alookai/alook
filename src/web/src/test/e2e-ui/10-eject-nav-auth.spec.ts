import { test, expect } from "./_fixtures/community-fixture"
import { seedServer, seedChannel } from "./_fixtures/seed"

// Journey 10 — eject / navigation / logout safety.
test.describe.serial("eject, navigation & logout", () => {
  let serverId: string
  let channelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `Eject ${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "eject-chan")
  })

  test("direct URL to a server you're not in redirects away", async ({ asUser }) => {
    // Carol is not a member.
    const { page } = await asUser("carol")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page).not.toHaveURL(new RegExp(`/channels/${serverId}/${channelId}$`), { timeout: 20_000 })
  })

  test("clicking a rail server lands on a channel, not the bare server root", async ({ asUser }) => {
    // Alice owns the server; navigating via the rail resolves to a channel.
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    // The bare-server route redirects to the first channel.
    await page.waitForURL(/\/c\/channels\/[^/]+\/[^/]+/, { timeout: 20_000 })
    expect(page.url()).toMatch(new RegExp(`/channels/${serverId}/[^/]+`))
  })

  test("logout clears the session", async ({ asUser }) => {
    const { page } = await asUser("bob")
    await page.goto("/c")
    await page.waitForURL(/\/c/, { timeout: 20_000 })

    // Drive the real logout: User settings → Log Out → redirect to sign-in.
    await page.getByRole("button", { name: "User settings" }).click()
    await page.getByRole("button", { name: "Log Out" }).click()
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 })

    // Session is actually cleared: revisiting a protected route stays bounced.
    await page.goto("/c")
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 })
    await expect(page).toHaveURL(/\/sign-in/)
  })
})
