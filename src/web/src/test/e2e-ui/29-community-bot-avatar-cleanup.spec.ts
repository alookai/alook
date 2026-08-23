import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { WEB_URL } from "./_setup/paths"

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="

function aliceHeaders(extra?: Record<string, string>) {
  return {
    Cookie: sessionCookie("alice"),
    Origin: WEB_URL,
    ...extra,
  }
}

async function pairMachine(): Promise<string> {
  const pair = await fetch(`${WEB_URL}/api/community/machines/pair`, {
    method: "POST",
    headers: aliceHeaders(),
  })
  expect(pair.status).toBe(200)
  const { tokenId } = await pair.json() as { tokenId: string }

  const activate = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenId}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      hostname: `avatar-e2e-${Date.now()}`,
      platform: "darwin",
      arch: "arm64",
      runtimeReport: [{ id: "codex", status: "healthy" }],
    }),
  })
  expect(activate.status).toBe(200)
  const body = await activate.json() as { machineId: string }
  return body.machineId
}

async function createBot(machineId: string, name: string): Promise<string> {
  const response = await fetch(`${WEB_URL}/api/community/bots`, {
    method: "POST",
    headers: aliceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, machineId, runtime: "codex" }),
  })
  expect(response.status).toBe(201)
  const body = await response.json() as { bot: { id: string } }
  return body.bot.id
}

async function uploadAvatar(page: import("@playwright/test").Page, botId: string): Promise<number> {
  return page.evaluate(async (
    { id, base64 }: { id: string; base64: string },
  ) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const form = new FormData()
    form.append("file", new File([bytes], "avatar.png", { type: "image/png" }))
    return (await fetch(`/api/community/bots/${id}/avatar`, {
      method: "POST",
      body: form,
      credentials: "include",
    })).status
  }, { id: botId, base64: ONE_PIXEL_PNG_BASE64 })
}

test("real bot avatars become unreadable after single delete and authenticated machine cascade", async ({ asUser }) => {
  test.setTimeout(120_000)
  const machineId = await pairMachine()
  const botName = `Avatar cleanup ${Date.now()}`
  const botId = await createBot(machineId, botName)
  const avatarPath = `/api/community/bots/${botId}/avatar`
  const alice = await asUser("alice")

  await gotoAfterUserWsAuth(alice.page, "/c/me/bots")
  const uploadStatus = await uploadAvatar(alice.page, botId)
  expect(uploadStatus).toBe(200)

  await alice.page.reload()
  await expect(alice.page.getByText(botName, { exact: true })).toBeVisible()
  const avatar = alice.page.locator(`img[src="${avatarPath}"]`)
  await expect(avatar).toBeVisible()
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1)
  expect(await alice.page.evaluate(async (path) => (
    await fetch(`${path}?before=${crypto.randomUUID()}`, { cache: "no-store" })
  ).status, avatarPath)).toBe(200)

  const deleteStatus = await alice.page.evaluate(async (id) => (
    await fetch(`/api/community/bots/${id}`, {
      method: "DELETE",
      credentials: "include",
    })
  ).status, botId)
  expect(deleteStatus).toBe(204)

  expect(await alice.page.evaluate(async (path) => (
    await fetch(`${path}?after=${crypto.randomUUID()}`, { cache: "no-store" })
  ).status, avatarPath)).toBe(404)

  await alice.page.reload()
  await expect(alice.page.getByText(botName, { exact: true })).toHaveCount(0)
  await expect(alice.page.locator(`img[src="${avatarPath}"]`)).toHaveCount(0)
  expect(await alice.page.evaluate(async (path) => (
    await fetch(`${path}?reload=${crypto.randomUUID()}`, { cache: "no-store" })
  ).status, avatarPath)).toBe(404)

  const machineDelete = await fetch(`${WEB_URL}/api/community/machines/${machineId}`, {
    method: "DELETE",
    headers: aliceHeaders(),
  })
  expect(machineDelete.status).toBe(204)

  const cascadeMachineId = await pairMachine()
  const cascadeBotName = `Cascade ${Date.now()}`
  const cascadeBotId = await createBot(cascadeMachineId, cascadeBotName)
  const cascadeAvatarPath = `/api/community/bots/${cascadeBotId}/avatar`
  expect(await uploadAvatar(alice.page, cascadeBotId)).toBe(200)
  await alice.page.reload()
  await expect(alice.page.getByText(cascadeBotName, { exact: true })).toBeVisible()
  expect(await alice.page.evaluate(async (path) => (
    await fetch(`${path}?before-cascade=${crypto.randomUUID()}`, { cache: "no-store" })
  ).status, cascadeAvatarPath)).toBe(200)

  const preflightStatus = await alice.page.evaluate(async (id) => (
    await fetch(`/api/community/machines/${id}`, {
      method: "DELETE",
      credentials: "include",
    })
  ).status, cascadeMachineId)
  expect(preflightStatus).toBe(409)

  const cascadeStatus = await alice.page.evaluate(async (id) => (
    await fetch(`/api/community/machines/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cascade: true }),
    })
  ).status, cascadeMachineId)
  expect(cascadeStatus).toBe(204)

  expect(await alice.page.evaluate(async (path) => (
    await fetch(`${path}?after-cascade=${crypto.randomUUID()}`, { cache: "no-store" })
  ).status, cascadeAvatarPath)).toBe(404)
  const listedBotIds = await alice.page.evaluate(async () => {
    const response = await fetch("/api/community/bots", {
      credentials: "include",
      cache: "no-store",
    })
    if (!response.ok) throw new Error(`bot list failed: ${response.status}`)
    const body = await response.json() as { bots: Array<{ id: string }> }
    return body.bots.map((bot) => bot.id)
  })
  expect(listedBotIds).not.toContain(cascadeBotId)
  await alice.page.reload()
  await expect(alice.page.getByText(cascadeBotName, { exact: true })).toHaveCount(0)
})
