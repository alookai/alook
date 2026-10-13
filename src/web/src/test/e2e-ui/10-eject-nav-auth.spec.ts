import { test, expect } from "./_fixtures/case-fixture"

import type { CaseActors } from "./_fixtures/case-fixture"

// Journey 10 — eject / navigation / logout safety.
test.describe("eject, navigation & logout", () => {
  async function prepareCase1(actors: CaseActors) {
    const { seedServer, seedChannel } = actors.seed
    const serverId: string = await seedServer("alice", `Eject ${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "eject-chan")
    return { serverId, channelId }
  }

  test("direct URL to a server you're not in redirects away", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "carol"])
    const { asUser } = actors
    const { serverId, channelId } = await prepareCase1(actors)

    // Carol is not a member.
    const { page } = await asUser("carol")
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    await expect(page).not.toHaveURL(new RegExp(`/channels/${serverId}/${channelId}$`), { timeout: 20_000 })
  })

  test("clicking a rail server lands on a channel, not the bare server root", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId } = await prepareCase1(actors)

    // Alice owns the server; navigating via the rail resolves to a channel.
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}`)
    // The bare-server route redirects to the first channel.
    await page.waitForURL(/\/c\/channels\/[^/]+\/[^/]+/, { timeout: 20_000 , waitUntil: "commit" })
    expect(page.url()).toMatch(new RegExp(`/channels/${serverId}/[^/]+`))
  })

  test("logout clears the session", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "logout"])
    const { asUser } = actors
    await prepareCase1(actors)

    const { page } = await asUser("logout")
    await page.goto("/c")
    await page.waitForURL(/\/c/, { timeout: 20_000 , waitUntil: "commit" })

    // Drive the real logout: User settings → Log Out → redirect to sign-in.
    await page.getByRole("button", { name: "User settings" }).click()
    await page.getByRole("button", { name: "Log Out" }).click()
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 , waitUntil: "commit" })

    // Session is actually cleared: a protected route returns a sign-in redirect.
    await expect.poll(async () => (await page.context().cookies())
      .some((cookie) => cookie.name.startsWith("better-auth"))).toBe(false)
    const protectedResponse = await page.request.get("/c", { maxRedirects: 0 })
    expect(protectedResponse.status()).toBe(307)
    const redirectLocation = protectedResponse.headers().location
    expect(redirectLocation).toBeTruthy()
    const redirectUrl = new URL(redirectLocation!, page.url())
    expect(redirectUrl.pathname).toBe("/sign-in")
    expect(redirectUrl.searchParams.get("redirect")).toBe("/c")
    await expect(page).toHaveURL(/\/sign-in/)
    await actors.confirmSignedOut("logout", { context: page.context(), page, protectedResponse })
  })
})
