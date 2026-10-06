import { test, expect } from "./_fixtures/community-fixture"

const retiredRoutes = ["/w", "/w/sample/home", "/w/sample/agents/a/chat/b", "/studio/new"]

test("authenticated legacy links land in Community without legacy API calls", async ({ asUser }) => {
  const { page } = await asUser("alice")
  const legacyRequests: string[] = []
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (/^\/api\/(?:workspaces|studios|invite|agents|conversations)(?:\/|$)/.test(path)) legacyRequests.push(path)
  })
  for (const path of retiredRoutes) {
    await page.goto(`${path}?token=private&workspace_id=private`, { waitUntil: "commit" })
    await expect(page).toHaveURL(/\/c\/me$/)
    await expect(page.locator("body")).toBeVisible()
  }
  expect(legacyRequests).toEqual([])
})

test("anonymous legacy links sign in with a canonical Community return path", async ({ page }) => {
  for (const path of retiredRoutes) {
    await page.goto(`${path}?token=private&workspace_id=private`, { waitUntil: "commit" })
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fc%2Fme$/)
    expect(page.url()).not.toContain("private")
  }
})

test("legacy invitations show retirement without reading or accepting the token", async ({ asUser }) => {
  const { page } = await asUser("alice")
  const legacyRequests: string[] = []
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/invite/")) legacyRequests.push(request.method())
  })
  await page.goto("/invite/not-a-community-token", { waitUntil: "commit" })
  await expect(page.getByRole("heading", { name: "Workspace invitations have been retired" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Open Community" })).toHaveAttribute("href", "/c/me")
  await expect(page.getByRole("button", { name: /accept|join/i })).toHaveCount(0)
  expect(legacyRequests).toEqual([])
})
