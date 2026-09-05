import { test, expect, sessionCookie, userId } from "./_fixtures/community-fixture"
import { captureNotificationRequests, gotoAfterNotificationStartup } from "./_fixtures/community-notification-requests"
import { seedCategory, seedChannel, seedChannelMember, seedForumThread, seedJoinServer, seedMessage, seedServer, seedThread } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

async function mutate(path: string, method: string, body?: unknown) {
  return fetch(`${WEB_URL}${path}`, {
    method,
    headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

for (const parentType of ["text", "forum"] as const) {
  for (const privateParent of [false, true]) {
    test(`${privateParent ? "private" : "public"} ${parentType} child separates readable content from participation`, async ({ asUser }, testInfo) => {
      test.setTimeout(120_000)
      const serverId = await seedServer("alice", `Realtime ${Date.now()}`)
      const categoryId = privateParent ? await seedCategory("alice", serverId, "Restricted realtime", { private: true }) : undefined
      const parentId = await seedChannel("alice", serverId, "realtime", parentType, categoryId)
      await seedJoinServer("alice", "bob", serverId)
      if (privateParent) await seedChannelMember("alice", parentId, userId("bob"))
      const childId = parentType === "forum"
        ? await seedForumThread("alice", parentId, "Live post", "Initial content")
        : await seedThread("alice", await seedMessage("alice", parentId, "Thread opener"), "Live thread")
      const bob = await asUser("bob")
      const trace = captureNotificationRequests(bob.page)
      const proxy = await gotoAfterNotificationStartup(bob.page, bob.context, trace)
      try {
        trace.phase("content")
        trace.events.length = 0
        trace.requests.length = 0

        const firstId = await seedMessage("alice", childId, "Passive reader receives this")
        await expect.poll(() => trace.events.some((event) => event.type === "community:message.create" && event.message.id === firstId)).toBe(true)
        await bob.page.waitForTimeout(750)
        expect(trace.events.filter((event) => (event.type === "community:unread.bump" || event.type === "community:mention.create") && event.channelId === childId)).toEqual([])
        expect(trace.requests.filter((path) => path.startsWith("/api/community/users/me/inbox/") || path === "/api/community/users/me/dms" || path === `/api/community/channels/${childId}/read`)).toEqual([])

        await bob.page.goto(`/c/channels/${serverId}/${childId}`)
        await expect(bob.page.getByTestId(tid.message(firstId))).toBeVisible()
        const added = await mutate(`/api/community/channels/${childId}/participants`, "POST", { userId: userId("bob") })
        expect(added.status).toBe(201)
        await expect.poll(() => trace.events.some((event) => event.type === "community:channel.member_add" && event.channelId === childId && event.userId === userId("bob"))).toBe(true)
        const removed = await bob.page.request.delete(`/api/community/channels/${childId}/participants/${userId("bob")}`)
        expect(removed.status()).toBe(204)
        await expect.poll(() => trace.events.some((event) => event.type === "community:channel.member_remove" && event.channelId === childId && event.userId === userId("bob"))).toBe(true)
        await expect(bob.page.getByTestId(tid.message(firstId))).toBeVisible()
        const secondId = await seedMessage("alice", childId, "Still readable after leaving participation")
        await expect(bob.page.getByTestId(tid.message(secondId))).toBeVisible()

        if (privateParent) {
          const revoked = await mutate(`/api/community/channels/${parentId}/members/${userId("bob")}`, "DELETE")
          expect(revoked.status).toBe(204)
          await expect(bob.page.getByTestId(tid.message(secondId))).toHaveCount(0)
          const denied = await bob.page.request.get(`/api/community/channels/${childId}`)
          expect([403, 404]).toContain(denied.status())
          const lastId = await seedMessage("alice", childId, "Revoked reader cannot receive this")
          await bob.page.waitForTimeout(750)
          expect(trace.events.some((event) => event.type === "community:message.create" && event.message.id === lastId)).toBe(false)
        }
      } finally {
        await testInfo.attach("community-request-timeline", {
          body: JSON.stringify({ connectionFrames: proxy.connectionFrames, timeline: trace.timeline }, null, 2),
          contentType: "application/json",
        })
      }
    })
  }
}
