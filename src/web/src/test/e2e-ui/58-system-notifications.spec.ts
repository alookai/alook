import type { Page } from "@playwright/test"
import { expect, test, userName } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type Activation = {
  notificationId: string
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
    const state = {
      shows: [] as unknown[],
      dismissed,
      retryActivations: [] as unknown[],
      listener: null as null | { onmessage?: (value: unknown) => void },
      click: () => undefined,
    }
    let activated = pending === null && initialActivation !== null
    state.click = () => {
      if (!initialActivation || activated) return
      activated = true
      pending = initialActivation
      sessionStorage.setItem(usedKey, "used")
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
            if (command === "desktop_system_notification_take_activation") {
              const value = pending
              pending = null
              if (value) {
                activated = true
                sessionStorage.setItem(usedKey, "used")
              }
              return value
            }
            if (command === "desktop_system_notification_retry_activation") {
              const notificationId = args?.notificationId
              if (notificationId !== initialActivation?.notificationId || !activated) {
                throw new Error("activation_unavailable")
              }
              activated = false
              state.retryActivations.push(notificationId)
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

async function retriedNotifications(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __desktopNotificationTest: { retryActivations: unknown[] } }
  ).__desktopNotificationTest.retryActivations)
}

async function clickDesktopNotification(page: Page) {
  await page.evaluate(() => (
    window as typeof window & { __desktopNotificationTest: { click: () => void } }
  ).__desktopNotificationTest.click())
}

test.describe.serial("desktop system notifications", () => {
  test("a delivered message+bump bundle invokes the native command with the exact target", async ({ asUser }) => {
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

  test("a cold activation revalidates access and opens the exact message", async ({ asUser }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const serverId = await seedServer("alice", `notification-cold-${stamp}`)
    const channelId = await seedChannel("alice", serverId, `notification-cold-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const messageId = await seedMessage("alice", channelId, `Cold activation ${stamp}`)
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page, {
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      target: { kind: "server", serverId, channelId, messageId, seq: 1 },
    })

    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}`))
    await expect.poll(() => dismissedNotifications(bob.page)).toEqual([
      "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
    ])
    await expect(bob.page.getByTestId(tid.message(messageId))).toBeVisible({ timeout: 30_000 })
  })

  test("a deleted or inaccessible activation falls back to Inbox", async ({ asUser }) => {
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page, {
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71f",
      target: {
        kind: "server",
        serverId: "missing_server",
        channelId: "missing_channel",
        messageId: "missing_message",
        seq: 1,
      },
    })
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    await expect(bob.page.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "true")
    expect(await dismissedNotifications(bob.page)).toEqual([])
  })

  test("a transient validation failure re-arms the exact notification for a later click", async ({ asUser }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const serverId = await seedServer("alice", `notification-retry-${stamp}`)
    const channelId = await seedChannel("alice", serverId, `notification-retry-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const messageId = await seedMessage("alice", channelId, `Retry activation ${stamp}`)
    const notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f720"
    const bob = await asUser("bob")
    let attempts = 0
    await bob.page.route(`**/api/community/messages/${messageId}`, async (route) => {
      attempts += 1
      if (attempts === 1) {
        await route.fulfill({ status: 503, body: "temporarily unavailable" })
        return
      }
      await route.continue()
    })
    await installDesktopNotificationBridge(bob.page, {
      notificationId,
      target: { kind: "server", serverId, channelId, messageId, seq: 1 },
    })

    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")
    await expect(bob.page.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "true")
    await expect.poll(() => retriedNotifications(bob.page)).toEqual([notificationId])
    expect(await dismissedNotifications(bob.page)).toEqual([])

    await clickDesktopNotification(bob.page)
    await expect(bob.page).toHaveURL(new RegExp(`/c/channels/${serverId}/${channelId}`))
    await expect.poll(() => dismissedNotifications(bob.page)).toEqual([notificationId])
    expect(attempts).toBe(2)
  })
})
