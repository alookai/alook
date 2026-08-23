import type { Page, WebSocket } from "@playwright/test"
import { test, expect, sessionCookie, userId } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedCategory,
  seedChannel,
  seedChannelMember,
  seedForumThread,
  seedJoinServer,
  seedServer,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

type ChannelDeleteFrame = {
  type: "community:channel.delete"
  serverId: string
  channelId: string
  parentChannelId?: string
  parentMessageId?: string
}

function captureChannelDeletes(page: Page) {
  const frames: ChannelDeleteFrame[] = []
  const sockets = new Set<WebSocket>()
  page.on("websocket", (socket) => {
    sockets.add(socket)
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ChannelDeleteFrame
        if (frame.type === "community:channel.delete") frames.push(frame)
      } catch {}
    })
  })
  return { frames, sockets }
}

async function resolveOpener(forumId: string, childId: string): Promise<string> {
  const response = await fetch(
    `${WEB_URL}/api/community/channels/${forumId}/threads?order=createdAt&limit=50`,
    { headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL } },
  )
  expect(response.status).toBe(200)
  const body = await response.json() as {
    threads: Array<{ id: string; parentMessageId: string | null }>
  }
  const openerId = body.threads.find((thread) => thread.id === childId)?.parentMessageId
  expect(openerId).toBeTruthy()
  return openerId!
}

async function deletePostThroughUi(page: Page, childId: string, openerId: string) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/community/messages/${openerId}`
  ))
  await page.getByTestId(tid.forumThreadDeleteBtn(childId)).click()
  await expect(page.getByRole("heading", { name: "Delete post?" })).toBeVisible()
  await page.getByRole("button", { name: "Delete post", exact: true }).click()
  // The mutation's onMutate projection removes the card before the round-trip
  // settles; the response below still proves the canonical HTTP door.
  await expect(page.getByTestId(tid.forumThreadCard(childId))).toHaveCount(0)
  const response = await responsePromise
  expect(response.status()).toBe(204)
}

test("canonical forum-post delete converges author, manager, private WS, and active routes", async ({ asUser }) => {
  test.setTimeout(150_000)
  const serverId = await seedServer("alice", `Canonical delete ${Date.now()}`)
  const categoryId = await seedCategory("alice", serverId, "Private forum", { private: true })
  const forumId = await seedChannel("alice", serverId, "canonical-delete", "forum", categoryId)
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  await seedChannelMember("alice", forumId, userId("bob"))

  const authorChildId = await seedForumThread("bob", forumId, "Author deletes", "author body")
  const managerChildId = await seedForumThread("bob", forumId, "Manager deletes", "manager body")
  const [authorOpenerId, managerOpenerId] = await Promise.all([
    resolveOpener(forumId, authorChildId),
    resolveOpener(forumId, managerChildId),
  ])
  const forumRoute = `/c/channels/${serverId}/${forumId}`

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  const carol = await asUser("carol")
  const aliceDeletes = captureChannelDeletes(alice.page)
  const bobDeletes = captureChannelDeletes(bob.page)
  const carolDeletes = captureChannelDeletes(carol.page)

  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${authorChildId}`)
  await gotoAfterUserWsAuth(bob.page, forumRoute)
  await gotoAfterUserWsAuth(carol.page, "/c")
  await expect(bob.page.getByTestId(tid.forumThreadCard(authorChildId))).toBeVisible({ timeout: 20_000 })

  const unauthorizedStatus = await carol.page.evaluate(async (openerId) => {
    const response = await fetch(`/api/community/messages/${openerId}`, { method: "DELETE" })
    return response.status
  }, authorOpenerId)
  expect(unauthorizedStatus).toBe(403)

  const legacyStatus = await bob.page.evaluate(async (childId) => {
    const response = await fetch(`/api/community/channels/${childId}`, { method: "DELETE" })
    return response.status
  }, authorChildId)
  expect(legacyStatus).toBe(409)
  await expect(bob.page.getByTestId(tid.forumThreadCard(authorChildId))).toBeVisible()

  await deletePostThroughUi(bob.page, authorChildId, authorOpenerId)
  await expect(alice.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${forumId}$`), {
    timeout: 20_000,
  })
  await expect(alice.page.getByTestId(tid.forumNewPost)).toBeVisible()
  await expect.poll(() => aliceDeletes.frames.filter((frame) => frame.channelId === authorChildId))
    .toEqual([{
      type: "community:channel.delete",
      serverId,
      channelId: authorChildId,
      parentChannelId: forumId,
      parentMessageId: authorOpenerId,
    }])
  await expect.poll(() => bobDeletes.frames.filter((frame) => frame.channelId === authorChildId))
    .toHaveLength(1)
  expect(carolDeletes.frames.filter((frame) => frame.channelId === authorChildId)).toEqual([])

  await bob.page.reload()
  await expect(bob.page.getByTestId(tid.forumThreadCard(authorChildId))).toHaveCount(0)
  const deletedChildStatus = await bob.page.evaluate(async (childId) => {
    const response = await fetch(`/api/community/channels/${childId}`)
    return response.status
  }, authorChildId)
  expect(deletedChildStatus).toBe(404)

  await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${managerChildId}`)
  await gotoAfterUserWsAuth(alice.page, forumRoute)
  await expect(alice.page.getByTestId(tid.forumThreadCard(managerChildId))).toBeVisible({ timeout: 20_000 })
  await deletePostThroughUi(alice.page, managerChildId, managerOpenerId)
  await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${forumId}$`), {
    timeout: 20_000,
  })
  await expect.poll(() => bobDeletes.frames.filter((frame) => frame.channelId === managerChildId))
    .toHaveLength(1)
  await expect(alice.page.getByTestId(tid.forumThreadCard(managerChildId))).toHaveCount(0)
})
