import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, expectFooterGeometry } from "./_fixtures/bot-profile-audit"

test("CommunitySheet footers keep four consumers horizontal and intrinsic at 390/639/640", async ({ caseActors, caseResources }) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed
  const { cleanupCreatedResources, jsonRequest, pairMachine, createBot, headersFor } = await prepareCase(actors, caseResources)

  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
  await machine.opened
  const botName = `Footer bot ${Date.now().toString(36)}`
  await createBot(machineId, botName)
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, "/c/me/bots")

  const capacity = await jsonRequest<{ ownedCount: number; limit: number }>("alice", "/api/community/bots")
  expect(capacity.ownedCount).toBeLessThan(capacity.limit)
  const create = page.getByRole("button", { name: "Create a bot", exact: true })
  await expect(create).toBeEnabled()
  await create.click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, "Create a bot", ["Cancel", "Create bot"], width)
  }
  await page.getByRole("dialog", { name: "Create a bot", exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

  await page.locator('[data-slot="card"]')
    .filter({ has: page.getByText(botName, { exact: true }) })
    .getByRole("button", { name: "Bot actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, `Edit ${botName}`, ["Cancel", "Save"], width)
  }
  await page.getByRole("dialog", { name: `Edit ${botName}`, exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

  await cleanupCreatedResources()
  await gotoAfterUserWsAuth(page, "/c/me/machines")
  await page.getByTestId(tid.machinePairOpen).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, "Connect a machine", ["Done"], width)
  }
  await page.getByRole("dialog", { name: "Connect a machine", exact: true })
    .getByRole("button", { name: "Done", exact: true }).click()

  const serverId = await seedServer("alice", `footer-${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, `footer-${Date.now()}`)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const fileName = `footer-oracle-${Date.now()}.md`
  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`
  ))
  const messageResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially("Attachment footer oracle")
  await page.getByTestId(tid.composerFileInput).setInputFiles({
    name: fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from("# Footer oracle"),
  })
  await page.keyboard.press("Enter")
  expect((await uploadResponse).ok()).toBe(true)
  expect((await messageResponse).status()).toBe(201)
  await page.getByTestId(tid.attachmentCard(fileName)).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, fileName, ["Download"], width)
  }
})
