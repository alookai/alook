import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"

const deletedRoutes = ["/w", "/w/sample/home", "/w/sample.name/home", "/w/sample/agents/a/chat/b", "/workspaces", "/studio/new", "/invite/not-a-community-token"]

async function expectDeletedFrontend(page: Page) {
  const legacyRequests: string[] = []
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (/^\/api\/(?:workspaces|studios|invite|agents|conversations)(?:\/|$)/.test(path)) legacyRequests.push(path)
  })
  for (const path of deletedRoutes) {
    const response = await page.goto(`${path}?token=private&workspace_id=private`, { waitUntil: "commit" })
    expect(response?.status()).toBe(404)
    expect(response?.request().redirectedFrom()).toBeNull()
    expect(new URL(page.url()).pathname).toBe(path)
    await expect(page.getByText("The page you're looking for doesn't exist or has been moved. Check the address and try again.", { exact: true })).toBeVisible()
    await expect(page.getByText("Workspace invitations have been retired", { exact: true })).toHaveCount(0)
  }
  expect(legacyRequests).toEqual([])
}

test("authenticated deleted workspace links return ordinary 404s without legacy API calls", async ({ asUser }) => {
  const { page } = await asUser("alice")
  await expectDeletedFrontend(page)
})

test("anonymous deleted workspace links return ordinary 404s without a login redirect", async ({ page }) => {
  await expectDeletedFrontend(page)
})
