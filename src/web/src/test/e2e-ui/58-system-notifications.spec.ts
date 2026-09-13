import type { Page } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
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
    let pending = initialActivation && sessionStorage.getItem(usedKey) !== "used"
      ? initialActivation
      : null
    const state = {
      shows: [] as unknown[],
      listener: null as null | { onmessage?: (value: unknown) => void },
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
              if (value) sessionStorage.setItem(usedKey, "used")
              return value
            }
            if (command === "desktop_system_notification_show") {
              state.shows.push(args?.candidate)
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

test.describe.serial("desktop system notifications", () => {
  test("a delivered message+bump bundle invokes the native command with the exact target", async ({ asUser }) => {
    const stamp = Date.now()
    const serverId = await seedServer("alice", `notification-live-${stamp}`)
    const channelId = await seedChannel("alice", serverId, `notification-live-${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    const bob = await asUser("bob")
    await installDesktopNotificationBridge(bob.page)
    await gotoAfterUserWsAuth(bob.page, "/c/me/friends")

    const body = `Native notification ${stamp}`
    const messageId = await seedMessage("alice", channelId, body)
    await expect.poll(() => shownNotifications(bob.page)).toEqual([
      expect.objectContaining({
        title: expect.any(String),
        body,
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
  })
})
