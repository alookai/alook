import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, expectMessageVisible, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import type { Frame, Page, Request, Response as PlaywrightResponse } from "@playwright/test"
import { COMMUNITY_CONTRACT_VERSION, CommunityMessageResourceSchema, requestedCommunityContract } from "@alook/shared"
import { decodeCommunityReadResponse } from "@/lib/community/read-response"
import type { MessagesPage } from "@/lib/community/models/message"

import {
  communityFrameEvents,
  isCommunityBatchFrame,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"

function messageFrame(frame: CapturedCommunityFrame, channelId: string, content: string): boolean {
  return communityFrameEvents(frame).some((event) =>
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.content?.includes(content))
}

function captureMessageRepairs(page: Page, channelId: string) {
  const responses: PlaywrightResponse[] = []
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
      && !url.searchParams.has("entry")) responses.push(response)
  })
  return responses
}

async function decodedResponse(response: PlaywrightResponse) {
  expect(response.status()).toBe(200)
  const request = response.request()
  const url = new URL(response.url())
  return decodeCommunityReadResponse(`${url.pathname}${url.search}`, request.method(),
    new Response(null, { headers: response.headers() }), await response.json(),
    requestedCommunityContract(new Headers(request.headers())) ?? COMMUNITY_CONTRACT_VERSION)
}

async function expectRepairedMessage(responses: PlaywrightResponse[], channelId: string, content: string) {
  expect(responses.some((response) => new URL(response.url()).search === "")).toBe(true)
  const pages = await Promise.all(responses.map(async (response) => ({
    url: new URL(response.url()), page: await decodedResponse(response) as MessagesPage,
  })))
  const supplied = pages.find(({ page }) => page.messages.some((message) => message.content?.includes(content)))
  expect(supplied, "repair response must supply the missing full message").toBeDefined()
  const message = CommunityMessageResourceSchema.strip().parse(supplied!.page.messages.find((row) => row.content?.includes(content)))
  expect(message.channelId).toBe(channelId)
  expect(message.seq).toBe(2)
  expect(Number.isFinite(Date.parse(message.createdAt))).toBe(true)
  expect(supplied!.page.latestSeq).toBeGreaterThanOrEqual(message.seq)
  const since = supplied!.url.searchParams.get("since")
  if (since) expect(`${message.createdAt}|${message.id}` > since).toBe(true)
  return message
}

test.describe("committed message delivery QA", () => {
  test("Q4: a readable nonparticipant gets child content and parent projection without notifications", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser, userId } = actors
    const { seedChannel, seedForumThread, seedJoinServer, seedServer } = actors.seed

    const serverId = await seedServer("alice", `Parent projection ${Date.now()}`)
    const forumId = await seedChannel("alice", serverId, "parent-projection", "forum")
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    const threadId = await seedForumThread("alice", forumId, `Projection ${Date.now()}`, "opener")

    const carol = await asUser("carol")
    const carolProxy = await proxyCommunityWebSockets(carol.context)
    await gotoAfterUserWsAuth(carol.page, `/c/channels/${serverId}/${forumId}`)
    await expect(carol.page.getByTestId(tid.forumThreadCard(threadId))).toBeVisible({ timeout: 20_000 })
    const membersBefore = await carol.page.request.get(`/api/community/channels/${threadId}/members`)
    expect(membersBefore.status()).toBe(200)
    expect((await membersBefore.json() as { members: Array<{ id: string }> }).members.map((member) => member.id)).not.toContain(userId("carol"))
    const frameStart = carolProxy.frames.length

    const bob = await asUser("bob")
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${threadId}`)
    await expect(composerEditable(bob.page)).toBeVisible()
    const body = `participant reply ${Date.now()}`
    await sendMessage(bob.page, body)

    await expect.poll(() => carolProxy.frames.slice(frameStart).some((frame) => communityFrameEvents(frame).some((event) =>
        event.type === "community:channel.child_update"
        && event.parentChannelId === forumId
        && event.channelId === threadId)), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => carolProxy.frames.slice(frameStart).some((frame) => messageFrame(frame, threadId, body))).toBe(true)
    const childDelivery = carolProxy.frames.slice(frameStart).find((frame) => messageFrame(frame, threadId, body))!
    expect(communityFrameEvents(childDelivery).filter((event) =>
      event.type === "community:unread.bump" || event.type === "community:mention.create")).toEqual([])
    expect(carolProxy.frames.slice(frameStart).flatMap(communityFrameEvents).filter((event) =>
      event.channelId === threadId && event.userId === userId("carol")
      && (event.type === "community:unread.bump" || event.type === "community:mention.create" || event.type === "community:channel.member_add"))).toEqual([])
    const membersAfter = await carol.page.request.get(`/api/community/channels/${threadId}/members`)
    expect(membersAfter.status()).toBe(200)
    expect((await membersAfter.json() as { members: Array<{ id: string }> }).members.map((member) => member.id)).not.toContain(userId("carol"))
    await expect(carol.page.getByText(body, { exact: false })).toHaveCount(0)
  })

  test("Q7 channel: a held mention bundle is repaired before late release", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userId } = actors
    const { memberInfo, seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const serverId = await seedServer("alice", `Gap channel ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "gap-channel")
    await seedJoinServer("alice", "bob", serverId)
    await seedMessage("alice", channelId, "gap baseline")
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    const missing = `missing channel ${Date.now()}`
    const later = `later channel ${Date.now()}`
    const proxy = await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === channelId) {
        dropped = true
        return "hold"
      }
      if (armed && !dropped && messageFrame(frame, channelId, missing)) {
        dropped = true
        return "hold"
      }
      return "forward"
    } })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const repairResponses = captureMessageRepairs(bob.page, channelId)
    armed = true
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
    await editable.pressSequentially(` ${missing}`)
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    const repaired = await expectRepairedMessage(repairResponses, channelId, missing)
    expect(proxy.heldCount()).toBe(1)
    const heldBatch = proxy.frames.find((frame) => messageFrame(frame, channelId, missing))
    expect(heldBatch?.type).toBe("community:events.batch.v2")
    expect(communityFrameEvents(heldBatch!).some((event) =>
      event.type === "community:mention.create")).toBe(true)
    expect(communityFrameEvents(heldBatch!).find((event) => event.type === "community:message.create")?.message)
      .toMatchObject({ id: repaired.id, seq: repaired.seq })
    expect(proxy.releaseHeld((frame) => messageFrame(frame, channelId, missing))).toBe(1)
    await bob.page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(bob.page.getByText(missing, { exact: false })).toHaveCount(1)
    expect(proxy.frames.filter((frame) => messageFrame(frame, channelId, missing))).toHaveLength(1)
    await expect.poll(async () => {
      const response = await bob.page.request.get("/api/community/servers")
      const data = await response.json() as { servers: Array<{ id: string; mentions: number }> }
      const authoritative = data.servers.find((server) => server.id === serverId)?.mentions ?? 0
      const badge = bob.page.getByTestId(tid.railUnreadBadge(serverId))
      const badgeTexts = await badge.allTextContents()
      const displayed = badgeTexts.length === 0
        ? 0
        : badgeTexts.length === 1
          ? Number(badgeTexts[0]?.trim())
          : Number.NaN
      return displayed === authoritative
    }, { timeout: 20_000 }).toBe(true)
  })

  test("Q7 DM: a dropped message frame is repaired when a later seq arrives", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userId } = actors
    const { seedDm, seedDmMessage } = actors.seed

    const dmId = await seedDm("alice", userId("bob"))
    await seedDmMessage("alice", dmId, "dm gap baseline")
    const bob = await asUser("bob")
    let armed = false
    let dropped = false
    const missing = `missing dm ${Date.now()}`
    const later = `later dm ${Date.now()}`
    const proxy = await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (armed && !dropped && frame.type === "community:message.create" && frame.channelId === dmId) {
        dropped = true
        return "drop"
      }
      if (armed && !dropped && messageFrame(frame, dmId, missing)) {
        dropped = true
        return "drop"
      }
      return "forward"
    } })
    await gotoAfterUserWsAuth(bob.page, `/c/me/${dmId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/me/${dmId}`)
    const repairResponses = captureMessageRepairs(bob.page, dmId)
    const readResponses: PlaywrightResponse[] = []
    bob.page.on("response", (response) => {
      if (response.request().method() === "PUT" && response.status() === 200
        && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`) readResponses.push(response)
    })
    armed = true
    await sendMessage(alice.page, missing)
    await expect.poll(() => dropped, { timeout: 20_000 }).toBe(true)
    await sendMessage(alice.page, later)

    await expectMessageVisible(bob.page, missing)
    await expectMessageVisible(bob.page, later)
    const repaired = await expectRepairedMessage(repairResponses, dmId, missing)
    const missingFrame = proxy.frames.find((frame) => messageFrame(frame, dmId, missing))!
    expect(communityFrameEvents(missingFrame).find((event) => event.type === "community:message.create")?.message)
      .toMatchObject({ id: repaired.id, seq: repaired.seq })
    await expect(bob.page.getByTestId(tid.message(repaired.id))).toHaveCount(1)
    await expect(bob.page.getByText(later, { exact: false })).toHaveCount(1)
    const tail = proxy.frames.flatMap(communityFrameEvents).find((event) => event.type === "community:message.create"
      && event.channelId === dmId && event.message?.content?.includes(later))?.message
    expect(tail?.seq).toBe(3)
    await expect.poll(async () => {
      const reads = await Promise.all(readResponses.map(async (response) => await decodedResponse(response) as { targetSeq: number }))
      return reads.some((read) => read.targetSeq === tail!.seq)
    }, { timeout: 20_000 }).toBe(true)
  })

  test("Q8: capable duplicate suppression ends safely at full reload", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userId } = actors
    const { memberInfo, seedChannel, seedJoinServer, seedServer } = actors.seed

    const serverId = await seedServer("alice", `Atomic batch ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "atomic-batch")
    await seedJoinServer("alice", "bob", serverId)
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const bob = await asUser("bob")
    let armed = false
    let duplicated = false
    const body = `atomic duplicate ${Date.now()}`
    const attentionRequests: string[] = []
    bob.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/community/users/me/attention") {
        attentionRequests.push(request.url())
      }
    })
    const proxy = await proxyCommunityWebSockets(bob.context, { decide: (frame) => {
      if (
        armed
        && !duplicated
        && isCommunityBatchFrame(frame)
        && messageFrame(frame, channelId, body)
      ) {
        duplicated = true
        return "duplicate"
      }
      return "forward"
    } })
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(bob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    armed = true
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
    await editable.pressSequentially(` ${body}`)
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => duplicated, { timeout: 20_000 }).toBe(true)

    const batches = proxy.frames.filter((frame) =>
      isCommunityBatchFrame(frame) && messageFrame(frame, channelId, body))
    expect(batches).toHaveLength(1)
    const batch = batches[0]!
    expect(batch.type).toBe("community:events.batch.v2")
    expect(batch.operationId).toMatch(/^message:[A-Za-z0-9_-]{43}$/)
    expect(batch.operationDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(batch.wireDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(communityFrameEvents(batch).map((event) => event.type)).toEqual([
      "community:message.create",
      "community:unread.bump",
      "community:mention.create",
    ])
    const messageId = communityFrameEvents(batch)[0]?.message?.id
    expect(messageId).toBeTruthy()
    await expect(bob.page.getByTestId(tid.message(messageId!))).toHaveCount(1)

    const requestsBeforeReload = attentionRequests.length
    const pendingReloadRequests = new Set<Request>()
    const reloadFailures: string[] = []
    let reloadCommitted = false
    let completedReloadRequests = 0
    const trackReloadCommit = (frame: Frame) => {
      if (frame === bob.page.mainFrame()) reloadCommitted = true
    }
    const trackReloadRequest = (request: Request) => {
      if (reloadCommitted && request.method() === "GET"
        && new URL(request.url()).pathname === "/api/community/users/me/attention") {
        pendingReloadRequests.add(request)
      }
    }
    const finishReloadRequest = (request: Request) => {
      if (!pendingReloadRequests.has(request)) return
      void request.response().then(async (response) => {
        if (!response) throw new Error("Reload attention response missing")
        const failure = await response.finished()
        if (response.status() !== 200 || failure !== null) {
          reloadFailures.push(`HTTP ${response.status()}: ${failure?.message ?? "unexpected status"}`)
        } else {
          completedReloadRequests += 1
        }
      }).catch((error: unknown) => {
        reloadFailures.push(error instanceof Error ? error.message : String(error))
      }).finally(() => pendingReloadRequests.delete(request))
    }
    const failReloadRequest = (request: Request) => {
      if (!pendingReloadRequests.delete(request)) return
      reloadFailures.push(request.failure()?.errorText ?? "Reload attention request failed")
    }
    bob.page.on("framenavigated", trackReloadCommit)
    bob.page.on("request", trackReloadRequest)
    bob.page.on("requestfinished", finishReloadRequest)
    bob.page.on("requestfailed", failReloadRequest)
    try {
      await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
      await expect(bob.page.getByTestId(tid.message(messageId!))).toHaveCount(1)
      await expect.poll(() => ({
        requestsIncreased: attentionRequests.length > requestsBeforeReload,
        responseCompleted: completedReloadRequests > 0,
        pending: pendingReloadRequests.size,
        failures: reloadFailures,
      }), { timeout: 20_000 }).toEqual({
        requestsIncreased: true, responseCompleted: true, pending: 0, failures: [],
      })
    } finally {
      bob.page.off("framenavigated", trackReloadCommit)
      bob.page.off("request", trackReloadRequest)
      bob.page.off("requestfinished", finishReloadRequest)
      bob.page.off("requestfailed", failReloadRequest)
    }
    const requestsBeforeReplay = attentionRequests.length
    proxy.replay(batch)
    await expect.poll(() => attentionRequests.length, { timeout: 20_000 })
      .toBeGreaterThan(requestsBeforeReplay)
    await expect(bob.page.getByTestId(tid.message(messageId!))).toHaveCount(1)
  })

  test("Q9: every receiver gets the same batch-only channel and DM delivery", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userId } = actors
    const { memberInfo, seedChannel, seedDm, seedJoinServer, seedServer } = actors.seed

    const serverId = await seedServer("alice", `Batch receivers ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, "batch-receivers")
    await seedJoinServer("alice", "bob", serverId)
    const dmId = await seedDm("alice", userId("bob"))
    const bobInfo = await memberInfo("alice", serverId, userId("bob"))

    const firstBob = await asUser("bob")
    const secondBob = await asUser("bob")
    const firstProxy = await proxyCommunityWebSockets(firstBob.context)
    const secondProxy = await proxyCommunityWebSockets(secondBob.context)
    await gotoAfterUserWsAuth(firstBob.page, `/c/channels/${serverId}/${channelId}`)
    await gotoAfterUserWsAuth(secondBob.page, `/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(firstBob.page)).toBeVisible()
    await expect(composerEditable(secondBob.page)).toBeVisible()

    const alice = await asUser("alice")
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
    const firstChannelStart = firstProxy.frames.length
    const secondChannelStart = secondProxy.frames.length
    const editable = composerEditable(alice.page)
    await editable.click()
    await editable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
    await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
    await editable.pressSequentially(" batch channel")
    await alice.page.keyboard.press("Enter")
    await expect.poll(() => firstProxy.frames.slice(firstChannelStart).some((frame) =>
      isCommunityBatchFrame(frame)
      && communityFrameEvents(frame).some((event) => event.type === "community:mention.create")), {
      timeout: 20_000,
    }).toBe(true)
    await expect.poll(() => secondProxy.frames.slice(secondChannelStart).some((frame) =>
      isCommunityBatchFrame(frame)
      && communityFrameEvents(frame).some((event) => event.type === "community:mention.create")), {
      timeout: 20_000,
    }).toBe(true)
    await expectMessageVisible(firstBob.page, "batch channel")
    await expectMessageVisible(secondBob.page, "batch channel")

    await gotoAfterUserWsAuth(firstBob.page, `/c/me/${dmId}`)
    await gotoAfterUserWsAuth(secondBob.page, `/c/me/${dmId}`)
    await gotoAfterUserWsAuth(alice.page, `/c/me/${dmId}`)
    const firstDmStart = firstProxy.frames.length
    const secondDmStart = secondProxy.frames.length
    const dmBody = `batch dm ${Date.now()}`
    await sendMessage(alice.page, dmBody)
    await expectMessageVisible(firstBob.page, dmBody)
    await expectMessageVisible(secondBob.page, dmBody)

    expect(firstProxy.frames.slice(firstDmStart).filter((frame) =>
      isCommunityBatchFrame(frame) && messageFrame(frame, dmId, dmBody))).toHaveLength(1)
    expect(secondProxy.frames.slice(secondDmStart).filter((frame) =>
      isCommunityBatchFrame(frame) && messageFrame(frame, dmId, dmBody))).toHaveLength(1)
  })
})
