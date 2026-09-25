import { devices, type Page } from "@playwright/test"
import { expect, test, sessionCookie, userId } from "./_fixtures/community-fixture"
import { composerEditable } from "./_fixtures/actions"
import { seedCategory, seedChannel, seedChannelMember, seedDm, seedDmMessage, seedFriendship, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

type Activation = { notificationId: string; messageId: string; targetId: string }
type Bridge = { pending: Activation | null; listener: unknown; takes: number; dismissed: string[]; visibility: DocumentVisibilityState }

async function installMobileBridge(page: Page, activation: Activation | null) {
  await page.addInitScript((initial) => {
    const key = `qa-mobile-consumed:${initial?.notificationId}`
    const dismissedKey = "qa-mobile-notification-dismissed"
    const state: Bridge = {
      pending: initial && !sessionStorage.getItem(key) ? initial : null,
      listener: null,
      takes: 0,
      dismissed: JSON.parse(sessionStorage.getItem(dismissedKey) ?? "[]") as string[],
      visibility: "visible",
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.visibility })
    Object.defineProperty(window, "__mobileNotificationQa", { configurable: true, value: state })
    class Channel { onmessage?: (value: unknown) => void }
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { core: { Channel, invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "mobile_system_notification_listen") { state.listener = args?.channel; return 1 }
        if (command === "mobile_system_notification_take_activation") {
          state.takes += 1
          const value = state.pending
          state.pending = null
          if (value) sessionStorage.setItem(key, "1")
          return value
        }
        if (command === "mobile_system_notification_check_permission" || command === "mobile_system_notification_request_permission") return { permissionState: "prompt" }
        if (command === "mobile_system_notification_dismiss") {
          state.dismissed.push(args?.notificationId as string)
          sessionStorage.setItem(dismissedKey, JSON.stringify(state.dismissed))
          return undefined
        }
        return undefined
      } } },
    })
  }, activation)
}

async function resumeActivation(page: Page, activation: Activation) {
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __mobileNotificationQa: Bridge }).__mobileNotificationQa.takes)).toBeGreaterThan(0)
  await page.evaluate((value) => {
    const state = (window as typeof window & { __mobileNotificationQa: Bridge }).__mobileNotificationQa
    state.visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    state.pending = value
    state.visibility = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
  }, activation)
}

type MessageDoorEvidence = {
  status: number
  payload: { surfaceReceipt?: unknown; messages?: unknown }
}

async function captureMessageDoor(page: Page, targetId: string, messageId: string) {
  let capture!: (evidence: MessageDoorEvidence) => void
  let fail!: (error: unknown) => void
  const result = new Promise<MessageDoorEvidence>((resolve, reject) => {
    capture = resolve
    fail = reject
  })
  await page.route((url) => url.pathname === `/api/community/channels/${targetId}/messages`
    && url.searchParams.get("anchor") === messageId && url.searchParams.get("limit") === "1", async (route) => {
    try {
      const response = await route.fetch()
      const payload = await response.json()
      const evidence = { status: response.status(), payload }
      await route.fulfill({ response })
      capture(evidence)
    } catch (error) {
      fail(error)
      await route.abort()
    }
  })
  return { result }
}

async function deleteAsAlice(path: string) {
  const response = await fetch(`${WEB_URL}${path}`, { method: "DELETE", headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL } })
  expect(response.ok, `${path}: ${response.status}`).toBeTruthy()
}

let serverId: string
let channelId: string
let channelMessageId: string
let dmId: string
let dmMessageId: string
let dmSeq: number
let channelSeq: number

test.describe("mobile notification chat routes (native bridge simulation)", () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    serverId = await seedServer("alice", `mobile-route-${Date.now()}`)
    channelId = await seedChannel("alice", serverId, "notification-chat")
    await seedJoinServer("alice", "bob", serverId)
    channelMessageId = await seedMessage("alice", channelId, "Channel notification route evidence")
    await seedFriendship("alice", "bob", userId("bob"))
    dmId = await seedDm("alice", userId("bob"))
    dmMessageId = await seedDmMessage("alice", dmId, "DM notification route evidence")
    const seqs = await Promise.all([[dmId, dmMessageId], [channelId, channelMessageId]].map(async ([targetId, messageId]) => {
      const response = await fetch(`${WEB_URL}/api/community/channels/${targetId}/messages?anchor=${messageId}&limit=1`, { headers: { Cookie: sessionCookie("bob") } })
      expect(response.status).toBe(200)
      const payload = await response.json() as { messages: Array<{ id: string; seq: number }> }
      return payload.messages.find((message) => message.id === messageId)!.seq
    }))
    ;[dmSeq, channelSeq] = seqs
  })

  for (const mode of ["cold", "resume"] as const) {
    for (const surface of ["dm", "channel"] as const) {
      test(`${mode} ${surface} opens chat without a context sheet`, async ({ asUser }, testInfo) => {
        const { page } = await asUser("bob", devices["iPhone 13"])
        const targetId = surface === "dm" ? dmId : channelId
        const messageId = surface === "dm" ? dmMessageId : channelMessageId
        const activation = { notificationId: crypto.randomUUID(), targetId, messageId }
        await installMobileBridge(page, mode === "cold" ? activation : null)
        const door = await captureMessageDoor(page, targetId, messageId)
        await page.goto("/c/me/friends")
        if (mode === "resume") await resumeActivation(page, activation)
        const { status, payload } = await door.result
        expect(status).toBe(200)
        expect(payload.surfaceReceipt).toEqual({ channelId: targetId, surfaceKind: surface })
        expect(payload.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId })]))
        const path = surface === "dm" ? `/c/me/${targetId}` : `/c/channels/${serverId}/${targetId}`
        await expect(page).toHaveURL(`${WEB_URL}${path}`)
        await expect.poll(() => page.evaluate(() => (
          window as typeof window & { __mobileNotificationQa: Bridge }
        ).__mobileNotificationQa.dismissed)).toEqual([activation.notificationId])
        await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
        await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0)
        await testInfo.attach("message-door-evidence", { body: JSON.stringify({ simulation: "iPhone UA + Tauri command shim + browser visibility events", status, surfaceReceipt: payload.surfaceReceipt, messageId, url: page.url() }), contentType: "application/json" })
        await testInfo.attach("chat", { body: await page.screenshot(), contentType: "image/png" })
      })
    }
  }

  for (const kind of ["deleted", "revoked"] as const) {
    test(`${kind} target opens Inbox without unauthorized navigation`, async ({ asUser }, testInfo) => {
      const categoryId = kind === "revoked" ? await seedCategory("alice", serverId, `private-${Date.now()}`, { private: true }) : undefined
      const targetId = await seedChannel("alice", serverId, `${kind}-${Date.now()}`, "text", categoryId)
      if (kind === "revoked") await seedChannelMember("alice", targetId, userId("bob"))
      const messageId = await seedMessage("alice", targetId, `${kind} target evidence`)
      await deleteAsAlice(kind === "deleted" ? `/api/community/channels/${targetId}` : `/api/community/channels/${targetId}/members/${userId("bob")}`)
      const { page } = await asUser("bob", devices["iPhone 13"])
      await installMobileBridge(page, null)
      const door = await captureMessageDoor(page, targetId, messageId)
      const route = `/c/channels/${serverId}`
      await page.goto(route)
      await expect(page.getByTestId(tid.inboxTrigger)).toBeVisible({ timeout: 30_000 })
      await resumeActivation(page, { notificationId: crypto.randomUUID(), targetId, messageId })
      const { status } = await door.result
      expect([403, 404]).toContain(status)
      await expect(page.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "true")
      await expect(page).toHaveURL(`${WEB_URL}${route}`)
      expect(await page.evaluate(() => (
        window as typeof window & { __mobileNotificationQa: Bridge }
      ).__mobileNotificationQa.dismissed)).toEqual([])
      await testInfo.attach("fallback-evidence", { body: JSON.stringify({ kind, status, url: page.url() }), contentType: "application/json" })
    })
  }

  for (const surface of ["dm", "channel"] as const) {
    test(`ordinary ${surface} seq permalink retains message context`, async ({ asUser }, testInfo) => {
      const { page } = await asUser("bob", devices["iPhone 13"])
      const targetId = surface === "dm" ? dmId : channelId
      const messageId = surface === "dm" ? dmMessageId : channelMessageId
      const route = surface === "dm" ? `/c/me/${targetId}` : `/c/channels/${serverId}/${targetId}`
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === `/api/community/channels/${targetId}/messages`
          && url.searchParams.get("anchor") === messageId && response.ok()
      })
      await page.goto(`${route}?seq=${surface === "dm" ? dmSeq : channelSeq}`)
      const response = await responsePromise
      const payload = await response.json()
      const content = surface === "dm" ? "DM notification route evidence" : "Channel notification route evidence"
      expect(payload.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, content })]))
      const sheet = page.locator('[data-slot="sheet-content"]')
      await expect(sheet).toBeVisible()
      await expect(sheet.locator('[data-anchor-row="1"]').getByText(
        content, { exact: true },
      )).toBeVisible()
      await testInfo.attach("permalink-context", { body: JSON.stringify({ status: response.status(), messageId, url: page.url() }), contentType: "application/json" })
      await testInfo.attach("context", { body: await page.screenshot(), contentType: "image/png" })
    })
  }

  test("ordinary channel msg permalink retains its message anchor", async ({ asUser }, testInfo) => {
    const { page } = await asUser("bob", devices["iPhone 13"])
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.get("anchor") === channelMessageId && response.ok()
    })
    await page.goto(`/c/channels/${serverId}/${channelId}?msg=${channelMessageId}`)
    const response = await responsePromise
    const payload = await response.json()
    expect(payload.surfaceReceipt).toEqual({ channelId, surfaceKind: "channel" })
    expect(payload.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: channelMessageId })]))
    await expect(page.getByTestId(tid.message(channelMessageId))).toBeVisible()
    await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
    await testInfo.attach("msg-anchor-evidence", { body: JSON.stringify({ status: response.status(), surfaceReceipt: payload.surfaceReceipt, anchorId: channelMessageId, url: page.url() }), contentType: "application/json" })
  })

})
