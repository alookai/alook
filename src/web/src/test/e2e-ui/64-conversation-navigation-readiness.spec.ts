import type { Page, Request, Response, WebSocket, Frame } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { seedChannel, seedDm, seedDmMessage, seedForumThread, seedMessage, seedServer, seedThread } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { expectConversationReady, observeConversationTransport } from "./_fixtures/conversation-readiness"
import { captureReadyConversation, runRenderedNavigation } from "./_fixtures/rendered-navigation"

test.beforeEach(async ({ baseURL }) => {
  expect(baseURL, "seed helper origin must match the browser before any mutation").toBeTruthy()
  expect(new URL(WEB_URL).origin).toBe(new URL(baseURL!).origin)
})

type NavigationEvent = { at: number; kind: string; url: string; status?: number; detail?: unknown }

function captureNavigation(page: Page) {
  const events: NavigationEvent[] = []
  const errors: string[] = []
  const reads: Promise<void>[] = []
  const sockets = new Map<WebSocket, (frame: { payload: string | Buffer }) => void>()
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname.startsWith("/api/community/")) events.push({ at: Date.now(), kind: "request", url: url.pathname + url.search })
  }
  const onResponse = (response: Response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith("/api/community/")) return
    events.push({ at: Date.now(), kind: "response", url: url.pathname + url.search, status: response.status() })
    if (/\/(messages|read-state)$/.test(url.pathname) && response.status() === 200) {
      reads.push(response.json().then((body) => {
        events.push({ at: Date.now(), kind: "window", url: url.pathname, detail: { latestSeq: body.latestSeq,
          surfaceReceipt: body.surfaceReceipt, messages: body.messages?.map((message: { id: string; seq: number }) => ({ id: message.id, seq: message.seq })) } })
      }, () => { errors.push(`response-body-unavailable:${url.pathname}`) }))
    }
  }
  const onSocket = (socket: WebSocket) => {
    const handler = ({ payload }: { payload: string | Buffer }) => {
      try {
        const frame = JSON.parse(String(payload))
        for (const event of frame.type === "community:events.batch" ? frame.events : [frame]) events.push({ at: Date.now(), kind: "WS", url: new URL(socket.url()).pathname,
          detail: { type: event.type, channelId: event.channelId, seq: event.seq ?? event.message?.seq, messageId: event.messageId ?? event.message?.id } })
      } catch { errors.push("invalid-websocket-json") }
    }
    sockets.set(socket, handler); socket.on("framereceived", handler)
  }
  const onFrame = (frame: Frame) => { if (frame === page.mainFrame()) events.push({ at: Date.now(), kind: "URL", url: new URL(frame.url()).pathname }) }
  page.on("request", onRequest); page.on("response", onResponse); page.on("websocket", onSocket); page.on("framenavigated", onFrame)
  return { events, errors, settle: async () => { await Promise.all(reads); expect(errors).toEqual([]) }, stop: () => {
    page.off("request", onRequest); page.off("response", onResponse); page.off("websocket", onSocket); page.off("framenavigated", onFrame)
    for (const [socket, handler] of sockets) socket.off("framereceived", handler)
  } }
}

async function holdRsc(page: Page, path: string) {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const requests: Array<{ pathname: string; query: string; rsc: boolean; prefetch: boolean; at: number }> = []
  const pattern = `**${path}**`
  const handler = async (route: import("@playwright/test").Route) => {
    const url = new URL(route.request().url()); const headers = route.request().headers()
    if (!url.searchParams.has("_rsc")) return route.continue()
    requests.push({ pathname: url.pathname, query: url.search, rsc: headers.rsc === "1", prefetch: !!(headers["next-router-prefetch"] || headers["next-router-segment-prefetch"]), at: Date.now() })
    await gate; await route.continue()
  }
  await page.route(pattern, handler)
  let releasedAt: number | null = null
  return { held: () => requests.length, snapshot: () => ({ pattern, requests, releasedAt, selection: "path pattern and _rsc query; header purpose recorded separately" }), release: async () => {
    if (releasedAt !== null) return
    releasedAt = Date.now(); releaseGate(); await page.unroute(pattern, handler)
  } }
}

for (const subtype of ["text", "forum", "thread"] as const) {
  test(`warm ${subtype} server restore keeps its known structure and reaches consumer readiness`, async ({ asUser }, testInfo) => {
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
    const recording = captureNavigation(page)
    const events = recording.events
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
      const headers = await page.locator('[data-slot="message-header-identity"] > span[title]').allTextContents()
      await page.getByTestId(tid.homeButton).click()
      await expect(page.getByRole("textbox", { name: "Search friends" })).toBeVisible()
      const targetPath = `/c/channels/${serverId}/${targetId}`
      const gate = await holdRsc(page, `/c/channels/${serverId}`)
      try {
        await runRenderedNavigation(page, testInfo, "typed-rendered-restore", `[data-testid="${tid.serverIcon(serverId)}"]`, {
          paths: ["/c/me/friends", "/c/me", `/c/channels/${serverId}`, targetPath], finalPath: targetPath,
          scopes: [`server:${serverId}`], finalScope: `server:${serverId}`, headers,
          ...(subtype === "forum" ? { forum: true, forumPostTestId: tid.forumThreadCard(postId) } : { channelId: targetId, ...(subtype === "thread" ? { companionChannelIds: [parentId] } : {}) }), pendingKind: "server-conversation", subtype,
        }, async () => {
          try { await page.getByTestId(tid.serverIcon(serverId)).click(); await expect.poll(gate.held).toBeGreaterThan(0)
            events.push({ at: Date.now(), kind: "typed-restore-held", url: page.url(), detail: gate.snapshot() })
          } finally { await gate.release() }
          await ready()
          await captureReadyConversation(page, { pathname: targetPath, serverId, channelId: targetId, kind: subtype,
            ...(subtype === "forum" ? { forumPostTestId: tid.forumThreadCard(postId) } : { messageTestId: tid.message(messageId) }) }, testInfo, "qualified-typed-target")
          events.push({ at: Date.now(), kind: "typed-restore-ready", url: page.url(), detail: { subtype, targetId } })
        })
      } finally {
        await gate.release()
        await testInfo.attach("navigation-timeline", { body: JSON.stringify({ clock: "Unix epoch milliseconds", targetId, subtype, events, gate: gate.snapshot(), errors: recording.errors }), contentType: "application/json" })
      }
      await recording.settle()
      transport.assertHealthy()
    } finally {
      await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" })
      recording.stop(); transport.stop()
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
  const recording = captureNavigation(page)
  const events = recording.events
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
    const dmHeaders = await page.locator('[data-slot="message-header-identity"] > span[title]').allTextContents()
    await page.getByTestId(tid.serverIcon(serverId)).click()
    await expect(page.getByTestId(tid.message(channelMessage))).toBeVisible({ timeout: 30_000 })
    await ready("text")
    const gate = await holdRsc(page, `/c/me/${dmId}`)
    try {
      await runRenderedNavigation(page, testInfo, "known-DM-rendered-restore", `[data-testid="${tid.homeButton}"]`, {
        paths: [`/c/channels/${serverId}/${channelId}`, `/c/me/${dmId}`, "/c/me"], finalPath: `/c/me/${dmId}`,
        scopes: [`server:${serverId}`], channelId: dmId, headers: dmHeaders, pendingKind: "dm",
      }, async () => {
        try { await page.getByTestId(tid.homeButton).click(); await expect.poll(gate.held).toBeGreaterThan(0) }
        finally { await gate.release() }
        await ready("dm")
        await captureReadyConversation(page, { pathname: `/c/me/${dmId}`, channelId: dmId, kind: "dm", messageTestId: tid.message(dmMessage) }, testInfo, "qualified-DM")
        events.push({ at: Date.now(), kind: "known-DM-restore-ready", url: page.url(), detail: { dmId } })
      })
    } finally {
      await gate.release()
      await testInfo.attach("navigation-timeline", { body: JSON.stringify({ events, gate: gate.snapshot(), errors: recording.errors }), contentType: "application/json" })
    }
    await recording.settle()
    transport.assertHealthy()
  } finally {
    await testInfo.attach("conversation-transport", { body: JSON.stringify(transport.snapshot()), contentType: "application/json" })
    await testInfo.attach("navigation-state", { body: await page.screenshot(), contentType: "image/png" })
    recording.stop(); transport.stop()
  }
})
