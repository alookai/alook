import type { Page } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"

type Activation = {
  notificationId: string
  viewerUserId: string
  target: {
    kind: "server"
    serverId: string
    channelId: string
    messageId: string
    seq: number
  }
}

async function installDesktopNotificationBridge(
  page: Page,
  activation: Activation | null = null,
) {
  await page.addInitScript((initialActivation) => {
    const usedKey = initialActivation
      ? `notification-activation:${initialActivation.notificationId}`
      : ""
    const dismissedKey = "qa-desktop-notification-dismissed"
    const dismissed = JSON.parse(sessionStorage.getItem(dismissedKey) ?? "[]") as unknown[]
    let pending = initialActivation && sessionStorage.getItem(usedKey) !== "used"
      ? initialActivation
      : null
    const documentLoads = Number(sessionStorage.getItem("qa-desktop-document-loads") ?? "0") + 1
    sessionStorage.setItem("qa-desktop-document-loads", String(documentLoads))
    const state = {
      documentLoads,
      shows: [] as unknown[],
      dismissed,
      acked: [] as unknown[],
      listener: null as null | { onmessage?: (value: unknown) => void },
      click: () => undefined,
    }
    let activated = pending === null && initialActivation !== null
    state.click = () => {
      if (!initialActivation || activated) return
      activated = true
      pending = initialActivation
      state.listener?.onmessage?.(undefined)
    }
    class Channel {
      onmessage?: (value: unknown) => void
    }
    Object.defineProperty(window, "__desktopNotificationTest", {
      configurable: true,
      value: state,
    })
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          Channel,
          invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === "desktop_system_notification_listen") {
              state.listener = args?.channel as typeof state.listener
              return 1
            }
            if (command === "desktop_system_notification_unlisten") return undefined
            if (command === "desktop_system_notification_peek_activation") {
              return pending
            }
            if (command === "desktop_system_notification_ack_activation") {
              const notificationId = args?.notificationId
              state.acked.push(notificationId)
              if (pending?.notificationId === notificationId) {
                pending = null
                activated = true
                sessionStorage.setItem(usedKey, "used")
              }
              return undefined
            }
            if (command === "desktop_system_notification_show") {
              state.shows.push(args?.candidate)
              return undefined
            }
            if (command === "desktop_system_notification_dismiss") {
              state.dismissed.push(args?.notificationId)
              sessionStorage.setItem(dismissedKey, JSON.stringify(state.dismissed))
              return undefined
            }
            return undefined
          },
        },
      },
    })
  }, activation)
}

async function shownNotifications(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __desktopNotificationTest: { shows: unknown[] } }
  ).__desktopNotificationTest.shows)
}

async function dismissedNotifications(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __desktopNotificationTest: { dismissed: unknown[] } }
  ).__desktopNotificationTest.dismissed)
}

async function ackedNotifications(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __desktopNotificationTest: { acked: unknown[] } }
  ).__desktopNotificationTest.acked)
}

test.describe("desktop system notifications", () => {
  test("a delivered message+bump bundle invokes the native command with the exact target", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser, userName } = actors
    const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const serverName = `notification-live-${stamp}`
    const channelName = `notification-live-${stamp}`
    const serverId = await seedServer("alice", serverName)
    const channelId = await seedChannel("alice", serverId, channelName)
    await seedJoinServer("alice", "bob", serverId)
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page)
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    await expect(bob.page.getByTestId(tid.serverIcon(serverId))).toBeVisible()

    const body = `Native notification ${stamp}`
    const messageId = await seedMessage("alice", channelId, body)
    await expect.poll(() => shownNotifications(bob.page)).toEqual([
      expect.objectContaining({
        title: `${serverName} · #${channelName}`,
        body: `${userName("alice")}: ${body}`,
        target: {
          kind: "server",
          serverId,
          channelId,
          messageId,
          seq: expect.any(Number),
        },
      }),
    ])
  })

  test("a cold activation starts ordinary conversation navigation without a document reload", async ({ caseActors }) => {
    test.setTimeout(90_000)

    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const serverId = await seedServer("alice", `notification-cold-${stamp}`)
    const channelId = await seedChannel("alice", serverId, `notification-cold-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const messageId = await seedMessage("alice", channelId, `Cold activation ${stamp}`)
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page, {
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      viewerUserId: actors.userId("bob"),
      target: { kind: "server", serverId, channelId, messageId, seq: 1 },
    })

    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}`))
    await expect.poll(() => dismissedNotifications(bob.page)).toEqual([
      "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
    ])
    await expect(bob.page.getByTestId(tid.message(messageId))).toBeVisible({ timeout: 30_000 })
    expect(await bob.page.evaluate(() => (window as typeof window & { __desktopNotificationTest: {documentLoads:number} }).__desktopNotificationTest.documentLoads)).toBe(1)
  })

  test("activation starts its target checkpoint before a slow permission response", async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice", "bob"])
    const { asUser } = actors
    const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

    const stamp = Date.now()
    const serverId = await seedServer("alice", `notification-delayed-${stamp}`)
    const channelId = await seedChannel("alice", serverId, `notification-delayed-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const messageId = await seedMessage("alice", channelId, `Delayed activation ${stamp}`)
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page)
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    caseResources.own(release, async (captured) => { captured() })
    let permissionHeld = false
    await bob.page.route(url => url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.get("entry") === "1", async route => {
      permissionHeld = true
      await pending
      permissionHeld = false
      await route.continue()
    })
    const targetHref = `/c/channels/${serverId}/${channelId}`
    const targetLoading = bob.page.locator(`[data-community-target-href="${targetHref}"] main[data-testid="${tid.conversationResolutionPending}"]`)
    try {
      await bob.page.evaluate(value => {
        const state = (window as typeof window & {__desktopNotificationTest:{listener?:{onmessage?:(value:unknown)=>void}}}).__desktopNotificationTest
        const core = (window as typeof window & {__TAURI__:{core:{invoke:(command:string,args?:Record<string,unknown>)=>Promise<unknown>}}}).__TAURI__.core
        const original = core.invoke
        let activation: unknown = value
        core.invoke = async (command,args) => {
          if (command === "desktop_system_notification_peek_activation") return activation
          if (command === "desktop_system_notification_ack_activation") { activation = null; return undefined }
          return original(command,args)
        }
        state.listener?.onmessage?.(undefined)
      }, {notificationId:"4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f720",viewerUserId:actors.userId("bob"),target:{kind:"server",serverId,channelId,messageId,seq:1}})
      await expect.poll(() => permissionHeld).toBe(true)
      await expect(targetLoading).toHaveCount(1)
      await expect(targetLoading).toBeVisible()
      await expect(targetLoading).toHaveAttribute("aria-busy", "true")
      await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}`))
      await expect(targetLoading).toHaveCount(1)
      await expect(targetLoading).toBeVisible()
      await expect(targetLoading).toHaveAttribute("aria-busy", "true")
      expect(permissionHeld).toBe(true)
      expect(await ackedNotifications(bob.page)).toEqual([])
    } finally { release() }
    await expect(bob.page.getByTestId(tid.message(messageId))).toBeVisible({timeout:30_000})
    await expect.poll(()=>dismissedNotifications(bob.page)).toEqual(["4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f720"])
  })
})
