import { devices } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { type Bridge, installMobileBridge, resumeActivation, prepareCase1 } from "./_fixtures/mobile-notification-activation"

test.describe("mobile notification chat routes (native bridge simulation)", () => {
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
})
