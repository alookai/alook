import type { Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { seedChannel, seedDm, seedDmMessage, seedForumThread, seedMessage, seedServer, seedThread } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"

test.beforeEach(async ({ baseURL }) => {
  expect(baseURL, "seed helper origin must match the browser before any mutation").toBeTruthy()
  expect(new URL(WEB_URL).origin).toBe(new URL(baseURL!).origin)
})

type NavigationEvent = { at: number; kind: string; url: string; status?: number; detail?: unknown }

function captureNavigation(page: Page) {
  const events: NavigationEvent[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET") return
    const url = new URL(request.url())
    if (url.pathname.startsWith("/api/community/")) {
      events.push({ at: Date.now(), kind: "request", url: url.pathname + url.search })
    }
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith("/api/community/")) {
      events.push({ at: Date.now(), kind: "response", url: url.pathname + url.search, status: response.status() })
      if (/\/(messages|read-state)$/.test(url.pathname) && response.status() === 200) {
        void response.json().then((body) => {
          events.push({
            at: Date.now(),
            kind: "window",
            url: url.pathname + url.search,
            detail: {
              lastReadMessageId: body.lastReadMessageId,
              lastReadSeq: body.lastReadSeq,
              latestSeq: body.latestSeq,
              hasMoreOlder: body.hasMoreOlder,
              hasMoreNewer: body.hasMoreNewer,
              surfaceReceipt: body.surfaceReceipt,
              messages: body.messages?.map((message: { id: string; seq: number }) => ({ id: message.id, seq: message.seq })),
              readStates: body.readStates?.map((row: { channelId: string; lastReadSeq: number }) => ({ channelId: row.channelId, lastReadSeq: row.lastReadSeq })),
            },
          })
        }).catch(() => { })
      }
    }
  })
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        for (const event of frame.type === "community:events.batch" ? frame.events : [frame]) {
          events.push({
            at: Date.now(), kind: "WS", url: new URL(socket.url()).pathname, detail: {
              type: event.type, channelId: event.channelId, seq: event.seq ?? event.message?.seq, messageId: event.messageId ?? event.message?.id,
            }
          })
        }
      } catch { }
    })
  })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      events.push({ at: Date.now(), kind: "URL", url: new URL(frame.url()).pathname })
    }
  })
  return events
}

for (const subtype of ["text", "forum", "thread"] as const) {
  test(`warm ${subtype} server restore keeps its known structure while navigation is pending`, async ({ asUser }, testInfo) => {
    test.setTimeout(120_000)
    const serverId = await seedServer("alice", `Typed restore ${subtype} ${Date.now()}`)
    const parentId = await seedChannel("alice", serverId, "typed-target", subtype === "forum" ? "forum" : "text")
    let targetId = parentId
    let messageId = ""
    let postId = ""
    if (subtype !== "forum") {
      const openerId = await seedMessage("alice", parentId, "typed restore opener")
      if (subtype === "thread") targetId = await seedThread("alice", openerId, "typed thread")
      messageId = await seedMessage("alice", targetId, "typed target ready")
    } else {
      postId = await seedForumThread("alice", targetId, "typed target post", "typed target post content")
    }
    const { page } = await asUser("alice")
    const events = captureNavigation(page)
    const transport = observeConversationTransport(page)
    const ready = async () => {
      await expectConversationReady(page, {
        pathname: `/c/channels/${serverId}/${targetId}`, serverId, channelId: targetId,
        kind: subtype, ...(subtype === "forum" ? { forumPostTestId: tid.forumThreadCard(postId) } : { messageTestId: tid.message(messageId) }),
      }, testInfo)
      transport.assertHealthy()
    }
    try {
      await page.goto(`/c/channels/${serverId}/${targetId}`)
      await expect(subtype === "forum" ? page.getByTestId(tid.forumPostList) : page.getByTestId(tid.message(messageId))).toBeVisible({ timeout: 30_000 })
      await ready()
      await page.getByTestId(tid.homeButton).click()
      await expect(page.getByRole("textbox", { name: "Search friends" })).toBeVisible()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let navigationStarted = false
      await page.route(`**/c/channels/${serverId}**`, async (route) => {
        if (!new URL(route.request().url()).searchParams.has("_rsc")) return route.continue()
        navigationStarted = true
        await gate
        await route.continue()
      })
      try {
        await page.getByTestId(tid.serverIcon(serverId)).click()
        await expect.poll(() => navigationStarted).toBe(true)
        events.push({
          at: Date.now(), kind: "typed-restore-held", url: page.url(), detail: {
            subtype: await page.locator("[data-community-conversation-subtype]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-community-conversation-subtype"))),
            neutral: await page.locator("[data-community-unresolved-main]").count(),
          }
        })
        await expect(page.locator(`[data-community-conversation-subtype="${subtype}"]`).first()).toBeVisible()
        await expect(page.locator("[data-community-unresolved-main]")).toHaveCount(0)
        await testInfo.attach("typed-pending-state", { body: await page.screenshot(), contentType: "image/png" })
        release()
        await page.waitForURL(new RegExp(`/c/channels/${serverId}/${targetId}$`), { waitUntil: "commit" })
        await expect(subtype === "forum" ? page.getByTestId(tid.forumPostList) : page.getByTestId(tid.message(messageId))).toBeVisible({ timeout: 30_000 })
        await ready()
        events.push({ at: Date.now(), kind: "typed-restore-ready", url: page.url(), detail: { subtype, targetId } })
      } finally {
        await testInfo.attach("navigation-timeline", { body: JSON.stringify({ clock: "Unix epoch milliseconds", targetId, subtype, events }, null, 2), contentType: "application/json" })
        await testInfo.attach("navigation-state", { body: await page.screenshot(), contentType: "image/png" })
        release()
        await page.unrouteAll({ behavior: "wait" })
      }
      transport.assertHealthy()
    } finally {
      await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" })
      transport.stop()
    }
  })
}

test("Home restores a known DM structure from a ready server conversation", async ({ asUser }, testInfo) => {
  const serverId = await seedServer("alice", `DM restore ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "dm-restore-source")
  const channelMessage = await seedMessage("alice", channelId, "server ready")
  const dmId = await seedDm("alice", userId("bob"))
  const dmMessage = await seedDmMessage("bob", dmId, "remembered DM ready")
  const { page } = await asUser("alice")
  const events = captureNavigation(page)
  const transport = observeConversationTransport(page)
  const ready = async (kind: "text" | "dm") => {
    await expectConversationReady(page, {
      pathname: kind === "dm" ? `/c/me/${dmId}` : `/c/channels/${serverId}/${channelId}`,
      channelId: kind === "dm" ? dmId : channelId, ...(kind === "text" ? { serverId } : {}), kind,
      messageTestId: tid.message(kind === "dm" ? dmMessage : channelMessage),
    }, testInfo)
    transport.assertHealthy()
  }
  try {
    await page.goto(`${WEB_URL}/c/channels/${serverId}/${channelId}`)
    await expect(page.getByTestId(tid.message(channelMessage))).toBeVisible({ timeout: 30_000 })
    await ready("text")
    await page.goto(`${WEB_URL}/c/me/${dmId}`)
    await expect(page.getByTestId(tid.message(dmMessage))).toBeVisible({ timeout: 30_000 })
    await ready("dm")
    await page.getByTestId(tid.serverIcon(serverId)).click()
    await expect(page.getByTestId(tid.message(channelMessage))).toBeVisible({ timeout: 30_000 })
    await ready("text")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    await page.route(`**/c/me/${dmId}**`, async (route) => {
      if (!new URL(route.request().url()).searchParams.has("_rsc")) return route.continue()
      held = true
      await gate
      await route.continue()
    })
    try {
      await page.getByTestId(tid.homeButton).click()
      await expect.poll(() => held).toBe(true)
      await expect(page.locator('[data-community-main-kind="dm"]')).toBeVisible()
      await expect(page.locator("[data-community-unresolved-main]")).toHaveCount(0)
      await testInfo.attach("typed-dm-pending", { body: await page.screenshot(), contentType: "image/png" })
      release()
      await page.waitForURL(new RegExp(`/c/me/${dmId}$`), { waitUntil: "commit" })
      await expect(page.getByTestId(tid.message(dmMessage))).toBeVisible()
      await ready("dm")
      events.push({ at: Date.now(), kind: "known-DM-restore-ready", url: page.url(), detail: { dmId } })
    } finally {
      release()
      await page.unrouteAll({ behavior: "wait" })
      await testInfo.attach("navigation-timeline", { body: JSON.stringify(events, null, 2), contentType: "application/json" })
    }
    transport.assertHealthy()
  } finally {
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" })
    await testInfo.attach("navigation-state", { body: await page.screenshot(), contentType: "image/png" })
    transport.stop()
  }
})
