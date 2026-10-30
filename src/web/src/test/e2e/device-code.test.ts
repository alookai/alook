import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, DEV_WEB_URL } from "@alook/shared"
import { signUp, signIn, sessionRequest, sqlRun } from "@alook/test-utils"

const appUrl = process.env.APP_URL ?? DEV_WEB_URL
const email = `retired-cli-${randomUUID()}@test.local`
let cookie: string

beforeAll(async () => {
  expect((await signUp(email, "TestPassword123!", "Current login")).status).toBe(200)
  cookie = await signIn(email, "TestPassword123!")
})
afterAll(() => {
  sqlRun('DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)', email)
  sqlRun('DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)', email)
  sqlRun('DELETE FROM "user" WHERE email = ?', email)
})

describe("retired CLI connection", () => {
  it.each([
    ["GET", "/api/auth/device?user_code=RETIRED"],
    ["POST", "/api/auth/device/code"],
    ["POST", "/api/auth/device/token"],
    ["POST", "/api/auth/device/approve"],
    ["POST", "/api/auth/device/deny"],
    ["GET", "/api/me"],
    ["GET", "/api/workspaces"],
    ["POST", "/api/machine-tokens"],
    ["POST", "/api/machine-tokens/activate"],
    ["GET", "/api/ws/daemon"],
    ["POST", "/api/workspaces"],
    ...["register", "heartbeat", "sweep", "deregister", "tasks/poll",
      "tasks/retired/start", "tasks/retired/complete", "tasks/retired/fail",
      "tasks/retired/supersede", "tasks/retired/messages", "workspace/report", "skills/sync",
    ].map(path => ["POST", `/api/daemon/${path}`]),
  ])("%s %s is absent even with a valid browser session", async (method, path) => {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: { Cookie: cookie, Origin: appUrl, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ client_id: "alook-cli", userCode: "RETIRED" }) } : {}),
    })
    expect(response.status).toBe(404)
  })

  it.each(["/device", "/onboard.md"])("%s no longer offers the old CLI connection", async path => {
    expect((await fetch(`${appUrl}${path}`, { redirect: "manual" })).status).toBe(404)
  })

  it("keeps current Cookie login while rejecting an old CLI session bearer", async () => {
    const path = "/api/community/users/me/profile"
    expect((await sessionRequest(path, cookie)).status).toBe(200)
    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0]
    const response = await fetch(`${appUrl}${path}`, { headers: {
      Authorization: `Bearer ${sessionToken}`,
      [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION),
    } })
    expect(response.status).toBe(401)
  })
})
