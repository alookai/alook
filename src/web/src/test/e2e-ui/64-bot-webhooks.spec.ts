import { createHmac } from "node:crypto"
import { IM_CONNECTOR_CAPABILITY } from "@alook/shared"
import { expect, test } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase } from "./_fixtures/bot-profile-audit"

function signGitHubBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function signSlackBody(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`
}

test("My Bots Triggers sheet separates IM and Webhooks tabs, delivers signed GitHub event to bot WS, and supports test, pause, reset link, delete, and mobile viewport", async ({ caseActors, caseResources }) => {
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
  await expect(sheet.getByText("No IM channels yet")).toBeVisible()

  await sheet.getByTestId(tid.botTriggersTab("webhook")).click()
  await expect(sheet.getByText("No webhooks yet")).toBeVisible()

  await sheet.getByTestId(tid.botWebhooksCreateOpen).click()
  await expect(sheet.getByText("Choose a source")).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("github"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("stripe"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("openai"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("generic"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("slack"))).not.toBeVisible()

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
  await expect(sheet.getByText("No webhooks yet")).toBeVisible()

  await alice.page.setViewportSize({ width: 1280, height: 800 })
  await sheet.getByRole("button", { name: "Close" }).click()
  await expect(sheet).not.toBeVisible()
  await botCard.getByRole("button", { name: "Bot actions" }).click()
  await alice.page.getByRole("menuitem", { name: "View activity" }).click()
  await expect(
    alice.page.getByRole("button", {
      name: `Triggered by GitHub · alook CI ${suffix} — alookai/alook: CI failure (#1495)`,
    }),
  ).toBeVisible()
  await expect(
    alice.page.getByRole("button", {
      name: `Triggered by GitHub · alook CI ${suffix} — Test notification for alook CI ${suffix}`,
    }),
  ).toBeVisible()
})

test("IM Triggers support Slack allowlist -> one-click Allow -> NDJSON wake -> Activity Log and WeChat live QR WS flow", async ({ caseActors, caseResources }) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { headersFor, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, {
    machineId,
    headers: headersFor("alice"),
    capabilities: [IM_CONNECTOR_CAPABILITY],
  })
  await machine.opened

  const receivedAgentEvents: Array<{ type: string; agentId?: string; launchId?: string; prompt?: string }> = []
  let activeQrTrigger: { botId: string; triggerId: string; sessionId: string } | null = null
  machine.socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as {
      type: string
      agentId?: string
      launchId?: string
      prompt?: string
      requestId?: string
      botId?: string
      triggerId?: string
      provider?: string
    }
    if (frame.type === "agent:event") {
      receivedAgentEvents.push(frame)
    }
    if (frame.type === "im:qr_start" && frame.botId && frame.triggerId && frame.requestId) {
      const sessionId = `qr_e2e_${suffix}`
      activeQrTrigger = { botId: frame.botId, triggerId: frame.triggerId, sessionId }
      machine.socket.send(
        JSON.stringify({
          type: "im_status",
          requestId: frame.requestId,
          botId: frame.botId,
          triggerId: frame.triggerId,
          provider: "wechat",
          status: "pending",
          sessionId,
          qrUrl: `https://liteapp.weixin.qq.com/qr/${sessionId}`,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      )
    }
  })

  const botName = `IM Bot ${suffix}`
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
  await expect(sheet.getByText("No IM channels yet")).toBeVisible()

  // 1) Connect bidirectional Slack IM trigger.
  await sheet.getByTestId(tid.botWebhooksCreateOpen).click()
  await expect(sheet.getByText("Connect an IM platform")).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("telegram"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("feishu"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("slack"))).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookProviderSelect("wechat"))).toBeVisible()

  await sheet.getByTestId(tid.botWebhookProviderSelect("slack")).click()
  await sheet.getByTestId(tid.botWebhookNameInput).fill(`Team Slack ${suffix}`)
  const slackSigningSecret = `slack_secret_${suffix}_123456`
  await sheet.getByTestId(tid.botWebhookExternalSecretInput).fill(slackSigningSecret)
  await sheet.getByTestId(tid.botImBotTokenInput).fill(`xoxb-test-${suffix}`)

  const createSlackPromise = alice.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/community/bots/${botId}/webhooks`,
  )
  await sheet.getByTestId(tid.botWebhookSubmit).click()
  const createSlackRes = await createSlackPromise
  expect(createSlackRes.status()).toBe(201)
  const createdSlack = (await createSlackRes.json()) as { webhook: { id: string } }
  const slackTriggerId = createdSlack.webhook.id

  const credsPanel = sheet.getByTestId(tid.botWebhookCredentialsPanel)
  await expect(credsPanel).toBeVisible()
  const slackUrl = await credsPanel.getByTestId(tid.botWebhookUrlValue).inputValue()
  expect(slackUrl).toContain("/api/webhooks/bot/")
  await expect(credsPanel.getByTestId(tid.botWebhookTest(slackTriggerId))).not.toBeVisible()

  // 2) Signed Slack URL verification handshake.
  const challengeTs = String(Math.floor(Date.now() / 1000))
  const challengeBody = JSON.stringify({ type: "url_verification", challenge: `chal_${suffix}` })
  const challengeRes = await fetch(slackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": challengeTs,
      "x-slack-signature": signSlackBody(slackSigningSecret, challengeTs, challengeBody),
    },
    body: challengeBody,
  })
  expect(challengeRes.status).toBe(200)
  expect(await challengeRes.json()).toEqual({ challenge: `chal_${suffix}` })

  // 3) Unknown Slack sender is blocked by default allowlist.
  const blockedTs = String(Math.floor(Date.now() / 1000))
  const blockedBody = JSON.stringify({
    type: "event_callback",
    event_id: `Ev_block_${suffix}`,
    event_time: Number(blockedTs),
    event: {
      type: "message",
      channel_type: "im",
      channel: "D_IM_01",
      user: "U_ALICE_IM",
      text: "Hello from stranger",
      ts: `${blockedTs}.000100`,
    },
  })
  const blockedRes = await fetch(slackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": blockedTs,
      "x-slack-signature": signSlackBody(slackSigningSecret, blockedTs, blockedBody),
    },
    body: blockedBody,
  })
  expect(blockedRes.status).toBe(200)
  expect(await blockedRes.json()).toEqual({ ok: true, blocked: "sender_not_allowed" })
  expect(receivedAgentEvents.filter((ev) => ev.agentId === botId)).toHaveLength(0)

  // Dismiss reveal panel, expand Slack History, and one-click Allow U_ALICE_IM.
  await credsPanel.getByRole("button", { name: "Done" }).click()
  await alice.page.getByRole("button", { name: "I've saved it" }).click()
  await expect(credsPanel).not.toBeVisible()

  const slackCard = sheet.getByTestId(tid.botWebhookCard(slackTriggerId))
  await expect(slackCard).toBeVisible()
  await expect(sheet.getByTestId(tid.botWebhookTest(slackTriggerId))).not.toBeVisible()
  await sheet.getByTestId(tid.botWebhookDeliveriesToggle(slackTriggerId)).click()
  await expect(sheet.getByText(/Hello from stranger/)).toBeVisible()
  const allowButton = sheet.getByRole("button", { name: "Allow" }).first()
  await expect(allowButton).toBeVisible()
  const allowResPromise = alice.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/community/bots/${botId}/webhooks/${slackTriggerId}/allow-sender`,
  )
  await allowButton.click()
  expect((await allowResPromise).status()).toBe(200)

  // 4) Next Slack DM from U_ALICE_IM wakes bot with compact single-line JSON.
  const okTs = String(Math.floor(Date.now() / 1000))
  const okBody = JSON.stringify({
    type: "event_callback",
    event_id: `Ev_ok_${suffix}`,
    event_time: Number(okTs),
    event: {
      type: "message",
      channel_type: "im",
      channel: "D_IM_01",
      user: "U_ALICE_IM",
      text: "Ship IM triggers?",
      ts: `${okTs}.000200`,
    },
  })
  const okRes = await fetch(slackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": okTs,
      "x-slack-signature": signSlackBody(slackSigningSecret, okTs, okBody),
    },
    body: okBody,
  })
  expect(okRes.status).toBe(200)
  expect(await okRes.json()).toMatchObject({ ok: true, delivered: true })

  await expect.poll(() => receivedAgentEvents.filter((ev) => ev.agentId === botId).length).toBe(1)
  const wakePrompt = receivedAgentEvents[0]?.prompt ?? ""
  expect(wakePrompt).not.toContain("\n")
  const imLine = JSON.parse(wakePrompt) as {
    kind: string
    platform: string
    ref: string
    sender: { id: string }
    text: string
  }
  expect(imLine.kind).toBe("im")
  expect(imLine.platform).toBe("slack")
  expect(imLine.ref).toMatch(/^ext_sl_/)
  expect(imLine.sender.id).toBe("U_ALICE_IM")
  expect(imLine.text).toBe("Ship IM triggers?")

  // 5) Create WeChat IM trigger -> live QR WS roundtrip -> SVG QR -> confirmed via WS push.
  await sheet.getByTestId(tid.botWebhooksCreateOpen).click()
  await sheet.getByTestId(tid.botWebhookProviderSelect("wechat")).click()
  await sheet.getByTestId(tid.botWebhookNameInput).fill(`Personal WeChat ${suffix}`)
  await sheet.getByTestId(tid.botWebhookSubmit).click()

  await expect(sheet.getByTestId(tid.botImQrPanel)).toBeVisible()
  await expect(sheet.getByTestId(tid.botImQrSvg)).toBeVisible()
  await expect.poll(() => activeQrTrigger).not.toBeNull()

  machine.socket.send(
    JSON.stringify({
      type: "im_status",
      botId: activeQrTrigger!.botId,
      triggerId: activeQrTrigger!.triggerId,
      provider: "wechat",
      status: "confirmed",
      sessionId: activeQrTrigger!.sessionId,
      botAccountLabel: `wx_${suffix}@im.bot`,
    }),
  )
  await expect(sheet.getByText(`wx_${suffix}@im.bot`)).toBeVisible()
  await sheet.getByRole("button", { name: "Done" }).click()

  // Mobile 390px overflow check on IM tab with Slack + WeChat connected.
  await alice.page.setViewportSize({ width: 390, height: 844 })
  const overflow = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  // 6) Verify Slack IM wake row in Bot Activity Log.
  await alice.page.setViewportSize({ width: 1280, height: 800 })
  await sheet.getByRole("button", { name: "Close" }).click()
  await expect(sheet).not.toBeVisible()
  await botCard.getByRole("button", { name: "Bot actions" }).click()
  await alice.page.getByRole("menuitem", { name: "View activity" }).click()
  await expect(
    alice.page.getByRole("button", {
      name: /Slack · DM · U_ALICE_IM — Ship IM triggers\?/,
    }),
  ).toBeVisible()
})
