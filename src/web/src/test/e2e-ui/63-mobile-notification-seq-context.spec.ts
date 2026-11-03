import { devices } from "@playwright/test"
import { expect, test } from "./_fixtures/case-fixture"
import { prepareCase1 } from "./_fixtures/mobile-notification-activation"

test.describe("mobile notification chat routes (native bridge simulation)", () => {
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
})
