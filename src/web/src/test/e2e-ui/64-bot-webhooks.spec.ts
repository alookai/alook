import { createHmac } from "node:crypto"
import { expect, test } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase } from "./_fixtures/bot-profile-audit"

function signGitHubBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

test("My Bots Triggers sheet separates source picker and forms, delivers signed GitHub event to bot WS, and supports test, pause, reset link, delete, and mobile viewport", async ({ caseActors, caseResources }) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { headersFor, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
  await machine.opened

  const receivedAgentEvents: Array<{ type: string; agentId?: string; launchId?: string; prompt?: string }> = []
  machine.socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { type: string; agentId?: string; launchId?: string; prompt?: string }
    if (frame.type === "agent:event") {
      receivedAgentEvents.push(frame)
    }
  })

  const botName = `Trigger Bot ${suffix}`
  const botId = await createBot(machineId, botName)

  const alice = await asUser("alice")
  await alice.page.setViewportSize({ width: 1280, height: 800 })
  await gotoAfterUserWsAuth(alice.page, "/c/me/bots")

  const botCard = alice.page.locator('[data-shell="cassette"]').filter({ hasText: botName }).first()
  await expect(botCard).toBeVisible()
  await botCard.getByRole("button", { name: "Bot actions" }).click()
  await alice.page.getByTestId(tid.botWebhooksMenu(botId)).click()

  const sheet = alice.page.getByTestId(tid.botWebhooksSheet)
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("No triggers yet")).toBeVisible()

  await sheet.getByTestId(tid.botWebhooksCreateOpen).click()
  await expect(sheet.getByText("Choose a source")).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("github"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("stripe"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("openai"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("generic"))).toBeVisible()

  await sheet.getByTestId(tid.botWebhookProviderSelect("generic")).click()
  await expect(sheet.getByText("New Custom app trigger")).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookRequireSecret)).toBeVisible()
  await sheet.getByTestId(tid.botWebhookChangeProvider).click()

  await sheet.getByTestId(tid.botWebhookProviderSelect("github")).click()
  await expect(sheet.getByText("New GitHub trigger")).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookRequireSecret)).not.toBeVisible()
  await sheet.getByTestId(tid.botWebhookNameInput).fill(`alook CI ${suffix}`)
  const createResponsePromise = alice.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/community/bots/${botId}/webhooks`,
  )
  await sheet.getByTestId(tid.botWebhookSubmit).click()
  const createResponse = await createResponsePromise
  expect(createResponse.status()).toBe(201)
  const createdBody = (await createResponse.json()) as { webhook: { id: string } }
  const webhookId = createdBody.webhook.id

  const credsPanel = sheet.getByTestId(tid.botWebhookCredentialsPanel)
  await expect(credsPanel).toBeVisible()
  const webhookUrl = await credsPanel.getByTestId(tid.botWebhookUrlValue).inputValue()
  const signingSecret = await credsPanel.getByTestId(tid.botWebhookSecretValue).inputValue()
  expect(webhookUrl).toContain("/api/webhooks/bot/")
  expect(signingSecret.length).toBeGreaterThan(10)

  const payload = JSON.stringify({
    action: "completed",
    repository: { full_name: "alookai/alook" },
    sender: { login: "gusye" },
    workflow_run: {
      id: 42001,
      name: "CI",
      status: "completed",
      conclusion: "failure",
      head_branch: "feat/bot-webhooks",
      head_sha: "abcdef1234567890",
      html_url: "https://github.com/alookai/alook/actions/runs/42001",
      pull_requests: [{ number: 1495 }],
    },
  })
  const deliveryHeader = `gh-delivery-${suffix}`
  const ingestResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-GitHub-Delivery": deliveryHeader,
      "X-Hub-Signature-256": signGitHubBody(signingSecret, payload),
    },
    body: payload,
  })
  expect(ingestResponse.status).toBe(200)
  const ingestJson = (await ingestResponse.json()) as { ok: boolean; delivered?: boolean; deliveryId?: string }
  expect(ingestJson).toMatchObject({ ok: true, delivered: true })

  await expect.poll(() => receivedAgentEvents.filter((ev) => ev.agentId === botId).length).toBe(1)
  expect(receivedAgentEvents[0]?.prompt).toContain("[External Webhook Notification]")
  expect(receivedAgentEvents[0]?.prompt).toContain("alookai/alook")

  const duplicateResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-GitHub-Delivery": deliveryHeader,
      "X-Hub-Signature-256": signGitHubBody(signingSecret, payload),
    },
    body: payload,
  })
  expect(duplicateResponse.status).toBe(200)
  expect(await duplicateResponse.json()).toMatchObject({ ok: true, duplicate: true })

  await credsPanel.getByRole("button", { name: "Done" }).click()
  await alice.page.getByRole("button", { name: "I've saved them" }).click()
  await expect(credsPanel).not.toBeVisible()

  const webhookRow = sheet.getByTestId(tid.botWebhookCard(webhookId))
  await expect(webhookRow).toBeVisible()

  await sheet.getByTestId(tid.botWebhookDeliveriesToggle(webhookId)).click()
  await expect(sheet.getByText(/alookai\/alook: CI failure/)).toBeVisible()

  await sheet.getByTestId(tid.botWebhookTest(webhookId)).click()
  await expect.poll(() => receivedAgentEvents.filter((ev) => ev.agentId === botId).length).toBe(2)

  await sheet.getByTestId(tid.botWebhookToggle(webhookId)).click()
  await expect(webhookRow.getByText("Paused")).toBeVisible()
  const pausedResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-GitHub-Delivery": `gh-delivery-paused-${suffix}`,
      "X-Hub-Signature-256": signGitHubBody(signingSecret, payload),
    },
    body: payload,
  })
  expect(pausedResponse.status).toBe(200)
  expect(await pausedResponse.json()).toMatchObject({ ok: true, ignored: "disabled" })

  await sheet.getByTestId(tid.botWebhookRotate(webhookId)).click()
  await alice.page.getByRole("button", { name: "Reset link" }).click()
  await expect(credsPanel).toBeVisible()
  const rotatedUrl = await credsPanel.getByTestId(tid.botWebhookUrlValue).inputValue()
  expect(rotatedUrl).not.toBe(webhookUrl)

  const staleResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  expect(staleResponse.status).toBe(404)

  await credsPanel.getByRole("button", { name: "Done" }).click()
  await alice.page.getByRole("button", { name: "I've saved them" }).click()

  await alice.page.setViewportSize({ width: 390, height: 844 })
  const overflow = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  await sheet.getByTestId(tid.botWebhookDelete(webhookId)).click()
  await alice.page.getByRole("button", { name: "Delete trigger" }).click()
  await expect(sheet.getByText("No triggers yet")).toBeVisible()
})
