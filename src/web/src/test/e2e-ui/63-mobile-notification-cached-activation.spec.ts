import { devices } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { type Bridge, installMobileBridge, resumeActivation, foregroundActivation, prepareCase1 } from "./_fixtures/mobile-notification-activation"

test.describe("mobile notification chat routes (native bridge simulation)", () => {
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
})
