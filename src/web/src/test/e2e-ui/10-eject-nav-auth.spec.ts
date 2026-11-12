import { CURRENT_COMMUNITY_FIXTURE_HEADERS, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { expectPublicCommunityDocument } from "./_fixtures/community-ssr-frame"
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

  test("a bare server URL resolves to a channel", async ({ caseActors }) => {
    const actors = await caseActors(["alice"])
    const { asUser } = actors
    const { serverId } = await prepareCase1(actors)

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
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let ready!: () => void
    const held = new Promise<void>(resolve => { ready = resolve })
    let intercepted = false
    let signOutStarted = false
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/auth/sign-out") signOutStarted = true
    })
    await page.route("**/api/community/friends/pending", async route => {
      if (intercepted) { await route.continue(); return }
      intercepted = true
      const response = await fetch(route.request().url(), { headers: await route.request().allHeaders() })
      const body = Buffer.from(await response.arrayBuffer())
      expect(response.status).toBe(200)
      expect(response.headers.getSetCookie().some(value => value.startsWith("better-auth.session_data="))).toBe(true)
      ready()
      await released
      const headers = Object.fromEntries(response.headers)
      delete headers["content-encoding"]
      delete headers["content-length"]
      await route.fulfill({ status: response.status, headers, body })
    })
    try {
      await page.goto("/c")
      await page.waitForURL(/\/c/, { timeout: 20_000 , waitUntil: "commit" })
      await held
      await page.getByRole("button", { name: "User settings" }).click()
      await page.getByRole("button", { name: "Log Out" }).click()
      const admission = await page.evaluate(async () => {
        const paths = ["/api/auth/get-session", "/api/ws/token?refresh=1", "/api/community/servers", "/api/community/notifications/devices"]
        return Promise.all(paths.map(path => fetch(path).then(() => "sent", error => error.name)))
      })
      expect(admission).toEqual(["AbortError", "AbortError", "AbortError", "AbortError"])
      expect(signOutStarted).toBe(false)
    } finally { release() }
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 , waitUntil: "commit" })

    await expect.poll(async () => (await page.context().cookies())
      .some((cookie) => cookie.name.startsWith("better-auth"))).toBe(false)
    const publicDocumentResponse = await page.request.get("/c", { maxRedirects: 0 })
    expect(publicDocumentResponse.status()).toBe(200)
    expectPublicCommunityDocument(await publicDocumentResponse.text())
    const protectedResponse = await confirmCommunityFixtureApiResponse(page.request.get("/api/community/servers", { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS, maxRedirects: 0 }))
    expect(protectedResponse.status()).toBe(401)
    await page.goto("/c")
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fc$/)
    await actors.confirmSignedOut("logout", { context: page.context(), page, publicDocumentResponse, protectedResponse })
  })
})
