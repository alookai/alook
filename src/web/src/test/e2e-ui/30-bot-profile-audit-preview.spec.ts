import { createRequire } from "module"
import { resolve } from "path"
import type { Page } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { REPO_ROOT, WEB_URL, WS_URL } from "./_setup/paths"

type UserKey = "alice" | "bob"

function headersFor(key: UserKey, extra?: Record<string, string>) {
  return {
    Cookie: sessionCookie(key),
    Origin: WEB_URL,
    ...extra,
  }
}

async function jsonRequest<T>(
  key: UserKey,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${WEB_URL}${path}`, {
    ...init,
    headers: headersFor(key, {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    }),
  })
  expect(response.status, `${init?.method ?? "GET"} ${path}`).toBeLessThan(300)
  return response.json() as Promise<T>
}

async function pairMachine(): Promise<{ credential: string; machineId: string }> {
  const pair = await jsonRequest<{ tokenId: string }>("alice", "/api/community/machines/pair", {
    method: "POST",
  })
  const response = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pair.tokenId}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      hostname: `profile-preview-e2e-${Date.now()}`,
      platform: "darwin",
      arch: "arm64",
      runtimeReport: [{ id: "codex", status: "healthy" }],
    }),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ credential: string; machineId: string }>
}

async function createBot(machineId: string, name: string): Promise<string> {
  const data = await jsonRequest<{ bot: { id: string } }>("alice", "/api/community/bots", {
    method: "POST",
    body: JSON.stringify({ name, machineId, runtime: "codex" }),
  })
  return data.bot.id
}

async function enrollBot(credential: string, botId: string): Promise<string> {
  const response = await fetch(`${WEB_URL}/api/community/daemon/enroll-agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ agentId: botId }),
  })
  expect(response.status).toBe(200)
  const data = await response.json() as { runnerKey: string }
  return data.runnerKey
}

async function sendBotMessage(runnerKey: string, channel: string, text: string): Promise<void> {
  const response = await fetch(`${WEB_URL}/api/community/channels/resolve/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runnerKey}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      channel,
      content: { text },
      attachments: [],
      seenUpToSeq: 0,
      nonce: `profile-preview:${crypto.randomUUID()}`,
    }),
  })
  expect(response.status).toBe(200)
  expect((await response.json() as { state: string }).state).toBe("sent")
}

type MachineSocket = {
  send: (data: string) => void
  close: () => void
  once(event: "open", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
}

function connectMachine(credential: string) {
  const requireFromDaemon = createRequire(resolve(REPO_ROOT, "src/daemon/package.json"))
  const Ws = requireFromDaemon("ws") as {
    WebSocket: new (url: string, options: { headers: Record<string, string> }) => MachineSocket
  }
  const socket = new Ws.WebSocket(WS_URL.replace(/^http/, "ws"), {
    headers: { Authorization: `Bearer ${credential}` },
  })
  return {
    socket,
    opened: new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen())
      socket.once("error", reject)
    }),
  }
}

async function openBotProfile(page: Page, botName: string): Promise<void> {
  await page.getByRole("button", { name: botName, exact: true }).click()
  await expect(page.getByTestId(tid.profileCard)).toBeVisible()
}

test("owner-only bot profile preview, owner swap, and URL-owned audit modal", async ({ asUser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `profile-preview-${suffix}`)
  const channelName = `bots-${suffix}`
  const channelId = await seedChannel("alice", serverId, channelName)
  await seedJoinServer("alice", "bob", serverId)

  const { credential, machineId } = await pairMachine()
  const botName = `Preview bot ${suffix}`
  const botId = await createBot(machineId, botName)
  await jsonRequest("alice", `/api/community/servers/${serverId}/bots`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  })

  const { servers } = await jsonRequest<{
    servers: Array<{ id: string; name: string; discriminator: string }>
  }>("alice", "/api/community/servers")
  const server = servers.find((candidate) => candidate.id === serverId)
  expect(server).toBeTruthy()
  const runnerKey = await enrollBot(credential, botId)
  await sendBotMessage(
    runnerKey,
    `/${server!.name}#${server!.discriminator}/${channelName}`,
    `Open my profile ${suffix}`,
  )

  const machine = connectMachine(credential)
  await machine.opened
  try {
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "idle" }))
    for (const index of [1, 2, 3, 4, 5, 6]) {
      machine.socket.send(JSON.stringify({
        type: "bot_audit_event",
        agentId: botId,
        sessionId: `session-${suffix}`,
        launchId: `launch-${suffix}`,
        event: { kind: "tool_call", payload: { name: `Tool ${index}` } },
      }))
    }

    await expect.poll(async () => {
      const response = await fetch(
        `${WEB_URL}/api/community/bots/${botId}/audit-log?limit=5`,
        { headers: headersFor("alice") },
      )
      if (!response.ok) return 0
      return ((await response.json()) as { events: unknown[] }).events.length
    }).toBe(5)

    const route = `/c/channels/${serverId}/${channelId}`
    const alice = await asUser("alice")
    const ownerAuditRequests: string[] = []
    alice.page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/community/bots/${botId}/audit-log`) {
        ownerAuditRequests.push(request.url())
      }
    })
    await gotoAfterUserWsAuth(alice.page, route)
    await openBotProfile(alice.page, botName)

    const preview = alice.page.getByTestId(tid.botAuditPreview)
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute(
      "aria-label",
      "Bot at rest. Open full bot activity log",
    )
    await expect(alice.page.locator('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveCount(5)
    expect(ownerAuditRequests.some((url) => new URL(url).searchParams.get("limit") === "5"))
      .toBe(true)

    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "running" }))
    await expect(preview).toHaveAttribute(
      "aria-label",
      "Bot activity in progress. Open full bot activity log",
    )
    await expect(alice.page.getByTestId(tid.botAuditPreviewActive)).toBeVisible()
    await expect(alice.page.locator('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveCount(4)

    await alice.page.setViewportSize({ width: 375, height: 812 })
    const ownerLink = alice.page.getByTestId(tid.profileOwnerLink)
    await expect(ownerLink).toBeVisible()
    const ownerLinkBox = await ownerLink.boundingBox()
    expect(ownerLinkBox?.height).toBeGreaterThanOrEqual(44)
    const ownerHandle = await ownerLink.textContent()
    await ownerLink.click()
    await expect(alice.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(alice.page.getByTestId(tid.profileOwnerLink)).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.profileCard))
      .toContainText(ownerHandle!.trim().replace(/^@/, ""))

    await alice.page.mouse.click(4, 4)
    await expect(alice.page.getByTestId(tid.profileCard)).toHaveCount(0)
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    await openBotProfile(alice.page, botName)
    await alice.page.getByTestId(tid.botAuditPreview).click()
    await expect(alice.page).toHaveURL(new RegExp(`/c/me/bots\\?audit=${botId}$`))
    await expect(alice.page.getByTestId("bot-activity-modal")).toBeVisible()
    await alice.page.reload()
    await expect(alice.page.getByTestId("bot-activity-modal")).toBeVisible()
    await alice.page.goBack({ waitUntil: "commit" })
    await expect(alice.page).toHaveURL(new RegExp(`${route}$`))
    await alice.page.goForward({ waitUntil: "commit" })
    await expect(alice.page.getByTestId("bot-activity-modal")).toBeVisible()

    await alice.page.goto(`/c/me/bots?machineId=${machineId}&audit=${botId}`)
    await expect(alice.page.getByTestId("bot-activity-modal")).toBeVisible()
    await alice.page.getByRole("button", { name: "Close", exact: true }).click()
    await expect(alice.page).toHaveURL(`/c/me/bots?machineId=${machineId}`)

    const bob = await asUser("bob")
    const bobAuditRequests: string[] = []
    bob.page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/community/bots/${botId}/audit-log`) {
        bobAuditRequests.push(request.url())
      }
    })
    await gotoAfterUserWsAuth(bob.page, route)
    await openBotProfile(bob.page, botName)
    await expect(bob.page.getByTestId(tid.profileOwnerLink)).toBeVisible()
    await expect(bob.page.getByTestId(tid.botAuditPreview)).toHaveCount(0)
    expect(bobAuditRequests).toEqual([])
    await bob.page.getByTestId(tid.profileOwnerLink).click()
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(bob.page.getByTestId(tid.profileOwnerLink)).toHaveCount(0)

    await bob.page.goto(`/c/me/bots?audit=${botId}`)
    await expect(bob.page.getByTestId("bot-activity-modal")).toHaveCount(0)
    await expect.poll(() => new URL(bob.page.url()).searchParams.has("audit")).toBe(false)
    expect(bobAuditRequests).toEqual([])
  } finally {
    machine.socket.close()
  }
})
