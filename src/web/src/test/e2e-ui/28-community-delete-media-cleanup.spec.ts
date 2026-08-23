import type { Page, WebSocket } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

type DeleteFrame = {
  type: "community:channel.delete" | "community:server.delete"
  serverId: string
  channelId?: string
}

function captureDeletes(page: Page) {
  const frames: DeleteFrame[] = []
  const sockets = new Set<WebSocket>()
  page.on("websocket", (socket) => {
    sockets.add(socket)
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as DeleteFrame
        if (frame.type === "community:channel.delete" || frame.type === "community:server.delete") {
          frames.push(frame)
        }
      } catch {}
    })
  })
  return { frames, sockets }
}

function headers(key: "alice" | "bob" | "carol") {
  return { Cookie: sessionCookie(key), Origin: WEB_URL }
}

async function uploadPending(
  key: "alice" | "bob" | "carol",
  channelId: string,
  name: string,
  withThumbnail: boolean,
): Promise<string> {
  const form = new FormData()
  form.append("file", new Blob([`original:${name}`], { type: "image/png" }), name)
  if (withThumbnail) {
    form.append(
      "thumbnail",
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
      `${name}.thumbnail.jpg`,
    )
  }
  const response = await fetch(`${WEB_URL}/api/community/channels/${channelId}/attachments`, {
    method: "POST",
    headers: headers(key),
    body: form,
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { id: string }
  return body.id
}

async function linkAttachment(
  key: "alice" | "bob" | "carol",
  channelId: string,
  attachmentId: string,
): Promise<void> {
  const response = await fetch(`${WEB_URL}/api/community/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...headers(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `media ${attachmentId}`,
      attachments: [attachmentId],
      nonce: `e2e:${crypto.randomUUID()}`,
    }),
  })
  expect(response.status).toBe(201)
}

async function uploadServerIcon(serverId: string): Promise<void> {
  const form = new FormData()
  form.append("file", new Blob(["server icon"], { type: "image/png" }), "server.png")
  const response = await fetch(`${WEB_URL}/api/community/servers/${serverId}/icon`, {
    method: "POST",
    headers: headers("alice"),
    body: form,
  })
  expect(response.status).toBe(200)
}

async function status(
  key: "alice" | "bob" | "carol",
  path: string,
  method = "GET",
): Promise<number> {
  return (await fetch(`${WEB_URL}${path}`, { method, headers: headers(key) })).status
}

test("existing channel/server deletes converge UI, WS, pending rows, linked media, and icon reads", async ({ asUser }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const channelServerId = await seedServer("alice", `C1 channel ${stamp}`)
  const channelId = await seedChannel("alice", channelServerId, `delete-media-${stamp}`, "text")
  await seedJoinServer("alice", "bob", channelServerId)
  const linkedChannelAttachment = await uploadPending("alice", channelId, "linked-channel.png", true)
  const pendingChannelAttachment = await uploadPending("alice", channelId, "pending-channel.png", true)
  await linkAttachment("alice", channelId, linkedChannelAttachment)

  const serverId = await seedServer("alice", `C1 server ${stamp}`)
  const serverChannelId = await seedChannel("alice", serverId, `delete-server-${stamp}`, "text")
  await seedJoinServer("alice", "bob", serverId)
  const linkedServerAttachment = await uploadPending("alice", serverChannelId, "linked-server.png", true)
  const pendingServerAttachment = await uploadPending("alice", serverChannelId, "pending-server.png", true)
  await linkAttachment("alice", serverChannelId, linkedServerAttachment)
  await uploadServerIcon(serverId)

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  const aliceDeletes = captureDeletes(alice.page)
  const bobDeletes = captureDeletes(bob.page)

  await gotoAfterUserWsAuth(alice.page, `/c/channels/${channelServerId}/${channelId}`)
  await gotoAfterUserWsAuth(bob.page, `/c/channels/${channelServerId}/${channelId}`)
  await expect(bob.page.getByTestId(tid.channelRow(channelId))).toBeVisible()

  expect(await status("bob", `/api/community/channels/${channelId}`, "DELETE")).toBe(403)
  expect(await status("carol", `/api/community/channels/${channelId}`, "DELETE")).toBe(403)
  expect(await status("alice", `/api/community/channels/${channelId}/attachments/${linkedChannelAttachment}`)).toBe(200)

  const channelDeleteResponse = alice.page.waitForResponse((response) => (
    response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}`
  ))
  await alice.page.getByTestId(tid.channelRow(channelId)).click({ button: "right" })
  await alice.page.getByRole("menuitem", { name: "Delete channel" }).click()
  await alice.page.getByRole("button", { name: "Delete channel", exact: true }).click()
  expect((await channelDeleteResponse).status()).toBe(204)

  await expect(alice.page.getByTestId(tid.channelRow(channelId))).toHaveCount(0)
  await expect(bob.page.getByTestId(tid.channelRow(channelId))).toHaveCount(0)
  await expect(alice.page).not.toHaveURL(new RegExp(`/${channelId}$`))
  await expect.poll(() => aliceDeletes.frames.filter((frame) => frame.channelId === channelId)).toHaveLength(1)
  await expect.poll(() => bobDeletes.frames.filter((frame) => frame.channelId === channelId)).toHaveLength(1)
  expect(await status("alice", `/api/community/channels/${channelId}/attachments/${linkedChannelAttachment}`)).toBe(404)
  expect(await status("alice", `/api/community/channels/${channelId}/attachments/${pendingChannelAttachment}`)).toBe(404)

  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${serverChannelId}`)
  await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${serverChannelId}`)
  await expect(bob.page.getByTestId(tid.serverIcon(serverId))).toBeVisible()
  expect(await status("bob", `/api/community/servers/${serverId}`, "DELETE")).toBe(403)
  expect(await status("carol", `/api/community/servers/${serverId}`, "DELETE")).toBe(403)
  expect(await status("alice", `/api/community/servers/${serverId}/icon`)).toBe(200)

  const serverDeleteResponse = alice.page.waitForResponse((response) => (
    response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/community/servers/${serverId}`
  ))
  await alice.page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
  await alice.page.getByTestId(tid.serverSettingsOpen).click()
  await expect(alice.page.getByTestId(tid.settingsShell)).toBeVisible()
  await alice.page.getByRole("button", { name: "Delete Server", exact: true }).click()
  await alice.page.getByRole("dialog").getByRole("button", {
    name: "Delete Server",
    exact: true,
  }).click()
  expect((await serverDeleteResponse).status()).toBe(204)

  await expect(alice.page).toHaveURL(/\/c\/me(?:\/friends)?$/)
  await expect(alice.page.getByTestId(tid.serverIcon(serverId))).toHaveCount(0)
  await expect(alice.page.getByTestId(tid.channelRow(serverChannelId))).toHaveCount(0)
  await expect(alice.page.getByTestId(tid.composerInput)).toHaveCount(0)
  await expect(bob.page.getByTestId(tid.serverIcon(serverId))).toHaveCount(0)
  await expect.poll(() => aliceDeletes.frames.filter((frame) => (
    frame.type === "community:server.delete" && frame.serverId === serverId
  ))).toHaveLength(1)
  await expect.poll(() => bobDeletes.frames.filter((frame) => (
    frame.type === "community:server.delete" && frame.serverId === serverId
  ))).toHaveLength(1)
  expect(await status("alice", `/api/community/servers/${serverId}/icon`)).toBe(404)
  expect(await status("alice", `/api/community/channels/${serverChannelId}/attachments/${linkedServerAttachment}`)).toBe(404)
  expect(await status("alice", `/api/community/channels/${serverChannelId}/attachments/${pendingServerAttachment}`)).toBe(404)

  await alice.page.goBack()
  await expect(alice.page).not.toHaveURL(new RegExp(`/c/channels/${serverId}/`))
  await expect(alice.page).toHaveURL(/\/c\/channels\/[^/]+\/[^/]+$/)
  const siblingRoute = new URL(alice.page.url()).pathname.match(/^\/c\/channels\/([^/]+)\/([^/]+)$/)
  expect(siblingRoute).not.toBeNull()
  const [, siblingServerId, siblingChannelId] = siblingRoute!
  expect(siblingServerId).not.toBe(serverId)
  expect(siblingChannelId).not.toBe(channelId)
  expect(siblingChannelId).not.toBe(serverChannelId)
  const liveServersResponse = await fetch(`${WEB_URL}/api/community/servers`, { headers: headers("alice") })
  expect(liveServersResponse.status).toBe(200)
  const liveServers = await liveServersResponse.json() as { servers: Array<{ id: string }> }
  expect(liveServers.servers.some(({ id }) => id === siblingServerId)).toBe(true)
  expect(liveServers.servers.some(({ id }) => id === serverId)).toBe(false)
  expect(await status("alice", `/api/community/channels/${siblingChannelId}`)).toBe(200)
  await expect(alice.page.getByTestId(tid.serverIcon(siblingServerId))).toBeVisible()
  await expect(alice.page.getByTestId(tid.channelRow(siblingChannelId))).toBeVisible()
  await alice.page.reload()
  await expect(alice.page).toHaveURL(new RegExp(`/c/channels/${siblingServerId}/${siblingChannelId}$`))
  await expect(alice.page.getByTestId(tid.serverIcon(serverId))).toHaveCount(0)
  await expect(alice.page.getByTestId(tid.channelRow(serverChannelId))).toHaveCount(0)
  await expect(alice.page.getByTestId(tid.serverIcon(siblingServerId))).toBeVisible()
  await expect(alice.page.getByTestId(tid.channelRow(siblingChannelId))).toBeVisible()
  await expect(alice.page.getByTestId(tid.composerInput)).toBeVisible()
})
