import { devices, type Page } from "@playwright/test"
import { COMMUNITY_CONTRACT_HEADER, DEFAULT_MESSAGE_PAGE_SIZE, type CommunityConversationEntryRead } from "@alook/shared"
import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { readCommunityDocumentSeedFromHtml } from "./_fixtures/community-ssr-frame"

import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import type { CaseActors } from "./_fixtures/case-fixture"

type Activation = { notificationId: string; messageId: string; targetId: string }
type Bridge = { pending: Activation | null; listener: unknown; takes: number; dismissed: string[]; visibility: DocumentVisibilityState; documentLoads: number }

async function installMobileBridge(page: Page, activation: Activation | null) {
  await page.addInitScript((initial) => {
    const key = `qa-mobile-consumed:${initial?.notificationId}`
    const dismissedKey = "qa-mobile-notification-dismissed"
    const documentLoads = Number(sessionStorage.getItem("qa-mobile-document-loads") ?? "0") + 1
    sessionStorage.setItem("qa-mobile-document-loads", String(documentLoads))
    const state: Bridge = {
      documentLoads,
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

async function foregroundActivation(page: Page, activation: Activation) {
  await expect.poll(() => page.evaluate(() => Boolean((
    window as typeof window & { __mobileNotificationQa: Bridge }
  ).__mobileNotificationQa.listener))).toBe(true)
  await page.evaluate((value) => {
    const state = (window as typeof window & { __mobileNotificationQa: Bridge }).__mobileNotificationQa
    state.pending = value
    ;(state.listener as { onmessage: (value: unknown) => void }).onmessage({})
  }, activation)
}

type MessageDoorEvidence = {
  status: number
  payload: { id?: string; channelId?: string }
}

test.describe("mobile notification chat routes (native bridge simulation)", () => {
  async function prepareCase1(actors: CaseActors) {
    async function deleteAsAlice(path: string) {
      const response = await fetch(`${WEB_URL}${path}`, { method: "DELETE", headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL } })
      expect(response.ok, `${path}: ${response.status}`).toBeTruthy()
    }
    async function captureMessageDoor(page: Page, targetId: string, messageId: string) {
      let observed: MessageDoorEvidence | undefined
      let requests = 0
      let capture!: (evidence: MessageDoorEvidence) => void
      let fail!: (error: unknown) => void
      const result = new Promise<MessageDoorEvidence>((resolve, reject) => {
        capture = resolve
        fail = reject
      })
      void result.catch(() => undefined)
      await page.route((url) => url.pathname === `/api/community/messages/${messageId}`, async (route) => {
        requests += 1
        try {
          const response = await route.fetch()
          const payload = await response.json()
          const evidence = { status: response.status(), payload }
          if (response.ok())
            expect(payload.channelId).toBe(targetId)
          observed = evidence
          await route.fulfill({ response })
          capture(evidence)
        }
        catch (error) {
          fail(error)
          await route.abort()
        }
      })
      return { result, evidence: () => observed, requestCount: () => requests }
    }
    const { sessionCookie, userId } = actors
    const { seedChannel, seedDm, seedDmMessage, seedFriendship, seedJoinServer, seedMessage, seedServer } = actors.seed
    const serverId: string = await seedServer("alice", `mobile-route-${Date.now()}`)
    const channelId: string = await seedChannel("alice", serverId, "notification-chat")
    await seedJoinServer("alice", "bob", serverId)
    const channelMessageId: string = await seedMessage("alice", channelId, "Channel notification route evidence")
    await seedFriendship("alice", "bob", userId("bob"))
    const dmId: string = await seedDm("alice", userId("bob"))
    const dmMessageId: string = await seedDmMessage("alice", dmId, "DM notification route evidence")
    const seqs = await Promise.all([[dmId, dmMessageId], [channelId, channelMessageId]].map(async ([targetId, messageId]) => {
      const response = await fetch(`${WEB_URL}/api/community/channels/${targetId}/messages?anchor=${messageId}&limit=1`, { headers: { Cookie: sessionCookie("bob") } })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        messages: Array<{
          id: string
          seq: number
        }>
      }
      return payload.messages.find((message) => message.id === messageId)!.seq
    }));
    const [dmSeq, channelSeq] = seqs
    return { deleteAsAlice, serverId, channelId, channelMessageId, dmId, dmMessageId, dmSeq, channelSeq, captureMessageDoor }
  }

  for (const mode of ["cold", "resume"] as const) {
    for (const surface of ["dm", "channel"] as const) {
      test(`${mode} ${surface} opens chat without a context sheet`, async ({ caseActors }, testInfo) => {
        const actors = await caseActors(["alice", "bob"])
        const { asUser } = actors
        const { serverId, channelId, channelMessageId, dmId, dmMessageId, captureMessageDoor } = await prepareCase1(actors)

        const { page } = await asUser("bob", devices["iPhone 13"])
        const targetId = surface === "dm" ? dmId : channelId
        const messageId = surface === "dm" ? dmMessageId : channelMessageId
        const activation = { notificationId: crypto.randomUUID(), targetId, messageId }
        await installMobileBridge(page, mode === "cold" ? activation : null)
        const door = await captureMessageDoor(page, targetId, messageId)
        await page.goto("/c/me/friends")
        if (mode === "resume") await resumeActivation(page, activation)
        const path = surface === "dm" ? `/c/me/${targetId}` : `/c/channels/${serverId}/${targetId}`
        await expect(page).toHaveURL(`${WEB_URL}${path}`)
        await expect.poll(() => page.evaluate(() => (
          window as typeof window & { __mobileNotificationQa: Bridge }
        ).__mobileNotificationQa.dismissed)).toEqual([activation.notificationId])
        expect(await page.evaluate(() => (window as typeof window & { __mobileNotificationQa: Bridge }).__mobileNotificationQa.documentLoads)).toBe(1)
        await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
        await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0)
        const evidence = door.evidence()
        if (evidence) {
          expect(evidence.status).toBe(200)
          expect(evidence.payload.id).toBe(messageId)
          expect(evidence.payload.channelId).toBe(targetId)
        }
        else expect(door.requestCount()).toBe(0)
        await testInfo.attach("message-door-evidence", { body: JSON.stringify({ simulation: "iPhone UA + Tauri command shim + browser visibility events", navigation: evidence ? "message resolution" : "cached conversation", evidence, messageDoorRequests: door.requestCount(), targetId, messageId, url: page.url() }), contentType: "application/json" })
        await testInfo.attach("chat", { body: await page.screenshot(), contentType: "image/png" })
      })
    }
  }

  for (const mode of ["foreground", "resume"] as const) {
    for (const surface of ["dm", "channel"] as const) {
      test(`cached ${mode} ${surface} opens directly in the same document`, async ({ caseActors }, testInfo) => {
        const actors = await caseActors(["alice", "bob"])
        const { serverId, channelId, channelMessageId, dmId, dmMessageId, captureMessageDoor } = await prepareCase1(actors)
        const { page } = await actors.asUser("bob", devices["iPhone 13"])
        const targetId = surface === "dm" ? dmId : channelId
        const messageId = surface === "dm" ? dmMessageId : channelMessageId
        const path = surface === "dm" ? `/c/me/${targetId}` : `/c/channels/${serverId}/${targetId}`
        const parent = surface === "dm" ? "/c/me" : `/c/channels/${serverId}`
        const activation = { notificationId: crypto.randomUUID(), targetId, messageId }
        await installMobileBridge(page, null)
        const door = await captureMessageDoor(page, targetId, messageId)
        await page.goto(path)
        await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
        const timeOrigin = await page.evaluate(() => performance.timeOrigin)
        await page.getByRole("button", { name: "Back", exact: true }).click()
        await expect(page).toHaveURL(`${WEB_URL}${parent}`)
        if (mode === "foreground") await foregroundActivation(page, activation)
        else await resumeActivation(page, activation)
        await expect(page).toHaveURL(`${WEB_URL}${path}`)
        await expect(composerEditable(page)).toBeVisible()
        await expect(page.getByTestId(tid.message(messageId))).toBeVisible()
        await expect.poll(() => page.evaluate(() => (
          window as typeof window & { __mobileNotificationQa: Bridge }
        ).__mobileNotificationQa.dismissed)).toEqual([activation.notificationId])
        expect(door.requestCount()).toBe(0)
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
        expect(await page.evaluate(() => (window as typeof window & { __mobileNotificationQa: Bridge }).__mobileNotificationQa.documentLoads)).toBe(1)
        await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0)
        await testInfo.attach("cached-navigation-evidence", { body: JSON.stringify({ simulation: "iPhone UA + Tauri command shim", mode, surface, targetId, messageId, messageDoorRequests: door.requestCount(), timeOrigin, documentLoads: 1, url: page.url() }), contentType: "application/json" })
        await testInfo.attach("chat", { body: await page.screenshot(), contentType: "image/png" })
      })
    }
  }

  for (const kind of ["deleted", "revoked"] as const) {
    test(`${kind} target shows an unavailable message page with the normal Inbox action`, async ({ caseActors }, testInfo) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser, userId } = actors
      const { seedCategory, seedChannel, seedChannelMember, seedMessage } = actors.seed
      const { deleteAsAlice, serverId, captureMessageDoor } = await prepareCase1(actors)

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
      const activation = { notificationId: crypto.randomUUID(), targetId, messageId }
      await resumeActivation(page, activation)
      const { status } = await door.result
      expect([403, 404]).toContain(status)
      await expect(page).toHaveURL(`${WEB_URL}/c/messages/${messageId}`)
      const unavailableAlert = page.getByTestId(tid.messageRouteAlert(messageId))
      await expect(unavailableAlert).toHaveCount(1)
      await expect(unavailableAlert).toBeVisible()
      await expect(unavailableAlert).toHaveText("This conversation is unavailable.")
      await page.getByRole("button", { name: "Open Inbox", exact: true }).click()
      await expect(page).toHaveURL(`${WEB_URL}/c/me`)
      await expect(page.getByTestId(tid.inboxTrigger)).toBeVisible()
      await expect(page.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "true")
      const inbox = page.getByTestId(tid.userBarExtension)
      await expect(inbox).toHaveCount(1)
      await expect(inbox).toBeVisible()
      await expect(inbox.locator("xpath=ancestor::*[@inert or @aria-hidden='true']")).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { __mobileNotificationQa: Bridge }
      ).__mobileNotificationQa.dismissed)).toEqual([activation.notificationId])
      const inboxHref = page.url()
      await page.getByRole("link", { name: /^Friends(?:, \d+ new requests)?$/ }).click()
      await expect(page).toHaveURL(`${WEB_URL}/c/me/friends`)
      await expect(page.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "false")
      await expect(page.getByTestId(tid.userBarExtension)).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { __mobileNotificationQa: Bridge }
      ).__mobileNotificationQa.dismissed)).toEqual([activation.notificationId])
      await testInfo.attach("fallback-evidence", { body: JSON.stringify({ kind, status, inboxHref, url: page.url() }), contentType: "application/json" })
    })
  }

  for (const surface of ["dm", "channel"] as const) {
    test(`ordinary ${surface} seq permalink retains message context`, async ({ caseActors }, testInfo) => {
      const actors = await caseActors(["alice", "bob"])
      const { asUser } = actors
      const { serverId, channelId, channelMessageId, dmId, dmMessageId, dmSeq, channelSeq } = await prepareCase1(actors)

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

  test("ordinary channel msg permalink retains its message anchor", async ({ caseActors }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { serverId, channelId, channelMessageId } = await prepareCase1(actors)
    const laterIds: string[] = []
    for (let index = 0; index < DEFAULT_MESSAGE_PAGE_SIZE + 8; index += 1) {
      laterIds.push(await actors.seed.seedMessage("alice", channelId, `Later window message ${index}`))
    }
    const readPointer = laterIds[DEFAULT_MESSAGE_PAGE_SIZE]
    const checkpoint = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
      method: "PUT",
      headers: { Cookie: actors.sessionCookie("bob"), Origin: WEB_URL, "Content-Type": "application/json" },
      body: JSON.stringify({ lastReadMessageId: readPointer }),
    })
    expect(checkpoint.ok).toBe(true)
    const defaultResponse = await fetch(`${WEB_URL}/api/community/channels/${channelId}/messages?entry=1`, { headers: { Cookie: actors.sessionCookie("bob"), [COMMUNITY_CONTRACT_HEADER]: "3" } })
    expect(defaultResponse.ok, `entry precondition status ${defaultResponse.status}`).toBe(true)
    const defaultEntry = await defaultResponse.json() as CommunityConversationEntryRead
    expect(defaultEntry.selection).toEqual({ reason: "read_pointer", anchorMessageId: readPointer })
    expect(defaultEntry.messages.some(message => message.id === channelMessageId)).toBe(false)
    expect(readPointer).not.toBe(laterIds.at(-1))

    const { page } = await asUser("bob", devices["iPhone 13"])
    const response = await page.goto(`/c/channels/${serverId}/${channelId}?msg=${channelMessageId}`)
    expect(response?.ok()).toBe(true)
    const html = await response!.text()
    const initialSeed = await readCommunityDocumentSeedFromHtml(html)
    expect(initialSeed.viewerId).toBe(actors.userId("bob"))
    const seeded = initialSeed.entries.find(entry => entry.target.channelId === channelId)
    expect(seeded?.target).toEqual({ channelId, serverId, anchorMessageId: channelMessageId, tag: null })
    expect(seeded?.data.selection).toEqual({ reason: "explicit_anchor", anchorMessageId: channelMessageId })
    expect(seeded?.data.surfaceReceipt).toEqual({ channelId, surfaceKind: "channel" })
    expect(seeded?.data.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: channelMessageId })]))
    expect(seeded?.data.messages.some(message => message.id === readPointer)).toBe(false)
    const target = page.getByTestId(tid.message(channelMessageId))
    await expect(target).toBeVisible()
    await expect(target.locator(".group").first()).toHaveClass(/bg-primary\/10/)
    const position = () => target.evaluate((node, scrollerId) => {
      const root = node.closest(`[data-testid="${scrollerId}"]`) as HTMLElement
      const rect = node.getBoundingClientRect()
      const viewport = root.getBoundingClientRect()
      return { inView: rect.top >= viewport.top && rect.bottom <= viewport.bottom, scrollTop: root.scrollTop, ready: root.querySelector("[data-read-position-ready]")?.getAttribute("data-read-position-ready") }
    }, tid.messageScroller)
    await expect.poll(position).toMatchObject({ inView: true, ready: "true" })
    await expect(page).toHaveURL(`${WEB_URL}/c/channels/${serverId}/${channelId}`)
    await expect(composerEditable(page)).toBeVisible({ timeout: 30_000 })
    await testInfo.attach("msg-anchor-evidence", { body: JSON.stringify({ status: response!.status(), htmlBytes: Buffer.byteLength(html), selection: seeded?.data.selection, surfaceReceipt: seeded?.data.surfaceReceipt, anchorId: channelMessageId, readPointer, latestId: laterIds.at(-1), defaultWindowIds: defaultEntry.messages.map(message => message.id), explicitWindowIds: seeded?.data.messages.map(message => message.id), position: await position(), url: page.url() }), contentType: "application/json" })
  })

})
