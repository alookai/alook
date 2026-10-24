import { expect, it } from "vitest"
import worker from "./discord-redirect"

it("redirects to the existing Discord community without requiring JavaScript", async () => {
  const response = worker.fetch()
  expect(response.status).toBe(302)
  expect(response.headers.get("Location")).toBe("https://discord.com/invite/24PHyEHU3M")
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(await response.text()).toBe("")
})
