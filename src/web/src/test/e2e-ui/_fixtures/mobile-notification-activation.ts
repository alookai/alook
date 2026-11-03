import type { z } from "zod"
import { communityFixtureFetch } from "./business-contract"
import { type Page } from "@playwright/test"
import { CommunityMessageReadSchema } from "@alook/shared"
import { expect } from "./case-fixture"
import { WEB_URL } from "../_setup/paths"
import type { CaseActors } from "./case-fixture"

type Activation = { notificationId: string; messageId: string; targetId: string }

export type Bridge = { pending: Activation | null; listener: unknown; takes: number; dismissed: string[]; visibility: DocumentVisibilityState; documentLoads: number }

export async function installMobileBridge(page: Page, activation: Activation | null) {
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

export async function resumeActivation(page: Page, activation: Activation) {
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

export async function foregroundActivation(page: Page, activation: Activation) {
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
  payload: z.infer<typeof CommunityMessageReadSchema>
}

export async function prepareCase1(actors: CaseActors) {
    async function deleteAsAlice(path: string) {
      const response = await communityFixtureFetch(`${WEB_URL}${path}`, { method: "DELETE", headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL } })
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
      const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${targetId}/messages?anchor=${messageId}&limit=1`, { headers: { Cookie: sessionCookie("bob") } })
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
