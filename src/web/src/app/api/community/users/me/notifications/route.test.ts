import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), getSettings: vi.fn(), db: {} }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: mocks.resolve } }))
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }))
vi.mock("@alook/shared", () => ({
  queries: { communityNotificationSetting: { getSettings: mocks.getSettings } },
}))

import { GET } from "./route"

const request = () => new NextRequest("http://localhost/api/community/users/me/notifications")

beforeEach(() => vi.resetAllMocks())

it("returns settings for each authenticated user without reusing the previous identity", async () => {
  const settings = [{ scopeId: "channel-a", muted: true }]
  mocks.getSettings.mockResolvedValue(settings)
  for (const userId of ["user-a", "user-b"]) {
    mocks.resolve.mockResolvedValue({ context: { env: { DB: {} }, userId } })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(settings)
    expect(mocks.getSettings).toHaveBeenLastCalledWith(mocks.db, userId)
  }
  expect(mocks.getSettings).toHaveBeenCalledTimes(2)
})

it("does not read settings when credentials are rejected", async () => {
  mocks.resolve.mockResolvedValue(new Response(null, { status: 401 }))
  expect((await GET(request())).status).toBe(401)
  expect(mocks.getSettings).not.toHaveBeenCalled()
})
