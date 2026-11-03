import { devices } from "@playwright/test"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { expect, test } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { type Bridge, installMobileBridge, resumeActivation, prepareCase1 } from "./_fixtures/mobile-notification-activation"

test.describe("mobile notification chat routes (native bridge simulation)", () => {
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
          expect(evidence.payload.contractVersion).toBe(BUSINESS_SCHEMA_VERSION)
          expect(evidence.payload.message.id).toBe(messageId)
          expect(evidence.payload.message.channelId).toBe(targetId)
          expect(evidence.payload.channelId).toBe(targetId)
        }
        else expect(door.requestCount()).toBe(0)
        await testInfo.attach("message-door-evidence", { body: JSON.stringify({ simulation: "iPhone UA + Tauri command shim + browser visibility events", navigation: evidence ? "message resolution" : "cached conversation", evidence, messageDoorRequests: door.requestCount(), targetId, messageId, url: page.url() }), contentType: "application/json" })
        await testInfo.attach("chat", { body: await page.screenshot(), contentType: "image/png" })
      })
}
}
})
