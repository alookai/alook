import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import type { Page, TestInfo } from "@playwright/test"
import { test, expect, type CaseActors, type CaseResources } from "./_fixtures/case-fixture"
import { communityFixtureFetch } from "./_fixtures/business-contract"
import { connectMachine } from "./_fixtures/community-machine"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

const runtimeReport = ["codex", "codex-app", "codex-cli"].map(id => ({
  id, status: "healthy", version: id === "codex-app" ? "1.2.3" : "4.5.6",
  reasoning: { updateMode: "live_next_turn", catalogOrigin: "native_report", defaultModelId: `${id}-model`,
    models: [{ id: `${id}-model`, supportedReasoningEfforts: [{ value: "high" }] }] },
}))

async function prepareMachine(actors: CaseActors, resources: CaseResources) {
  const headers = { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL, "Content-Type": "application/json" }
  const call = (path: string, method = "GET", body?: unknown) => communityFixtureFetch(`${WEB_URL}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const pair = await call("/api/community/machines/pair", "POST")
  expect(pair.status).toBe(200)
  const { tokenId } = await pair.json() as { tokenId: string }
  const activation = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
    method: "POST", headers: { Authorization: `Bearer ${tokenId}`, "Content-Type": "application/json" },
    body: JSON.stringify({ hostname: "codex-source-qa", platform: "darwin", arch: "arm64", osRelease: "qa", daemonVersion: "0.1.68", runtimeReport }),
  })
  expect(activation.status).toBe(200)
  const { machineId, credential } = await activation.json() as { machineId: string; credential: string }
  resources.own(machineId, async id => { expect([204, 404]).toContain((await call(`/api/community/machines/${id}`, "DELETE")).status) })
  const machine = connectMachine(credential, resources, { machineId, headers })
  machine.socket.on("message", data => {
    const frame = JSON.parse(String(data)) as { type: string; requestId: string; runtimeId: string }
    if (frame.type === "runtime:discover_models") machine.socket.send(JSON.stringify({ type: "runtime_models", requestId: frame.requestId, runtimeId: frame.runtimeId, result: { status: "complete", runtimeReport } }))
  })
  await machine.opened
  machine.socket.send(JSON.stringify({ type: "ready", hostname: "codex-source-qa", platform: "darwin", arch: "arm64", osRelease: "qa", daemonVersion: "0.1.68", runtimeReport, runningAgents: [], capabilities: ["control-heartbeat-v1", "runtime-model-discovery-v1"] }))
  const ownBot = (id: string) => resources.own(id, async botId => { expect([204, 404]).toContain((await call(`/api/community/bots/${botId}`, "DELETE")).status) })
  const readBot = async (id: string) => {
    const response = await call("/api/community/bots")
    expect(response.status).toBe(200)
    const body = await response.json() as { bots: Array<{ id: string; name: string; runtime: string; modelName: string | null; reasoningEffort: string | null }> }
    return body.bots.find(bot => bot.id === id)
  }
  return { machineId, call, ownBot, readBot }
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: "disabled" })
  await info.attach(name, { path, contentType: "image/png" })
}

for (const [runtime, label, previousRuntime, previousLabel] of [
  ["codex-app", "Codex", "codex-cli", "Codex CLI"],
  ["codex-cli", "Codex CLI", "codex-app", "Codex"],
] as const) {
  test(`${runtime} creation persists its source and clears another source's model and effort`, async ({ caseActors, caseResources }, info) => {
    const actors = await caseActors(["alice"])
    const fixture = await prepareMachine(actors, caseResources)
    const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" })
    await gotoAfterUserWsAuth(page, "/c/me/bots")
    await page.getByTestId(tid.createBot).click()
    const dialog = page.getByRole("dialog", { name: "Create a bot", exact: true })
    const picker = dialog.getByTestId(tid.botProviderPicker)
    await expect(picker.getByRole("radio")).toHaveCount(2)
    await expect(picker.getByRole("radio", { name: "Codex (automatic)", exact: true })).toHaveCount(0)
    await picker.getByRole("radio", { name: previousLabel, exact: true }).check()
    await dialog.getByTestId(tid.botModelSelect).click()
    await page.getByRole("option", { name: `${previousRuntime}-model`, exact: true }).click()
    await dialog.getByTestId(tid.botReasoningEffort).click()
    await page.getByRole("option", { name: "High", exact: true }).click()
    await picker.getByRole("radio", { name: label, exact: true }).check()
    await expect(picker.getByRole("radio", { name: label, exact: true })).toBeChecked()
    await expect(dialog.getByTestId(tid.botModelSelect).locator('[data-slot="select-value"]')).toHaveText(`Default (${label}'s own default)`)
    await expect(dialog.getByTestId(tid.botReasoningEffort).locator('[data-slot="select-value"]')).toHaveText("Default")
    await dialog.getByPlaceholder("Name your bot").fill(`Source ${runtime} ${randomUUID().slice(0, 8)}`)
    await screenshot(page, info, `${runtime}-selected`)
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/community/bots" && response.request().method() === "POST")
    await dialog.getByRole("button", { name: "Create bot", exact: true }).click()
    const response = await pending
    expect(response.status()).toBe(201)
    const request = response.request().postDataJSON() as { runtime: string; model?: string | null; reasoningEffort?: string | null }
    expect(request).toMatchObject({ runtime })
    expect(request.model ?? null).toBeNull()
    expect(request.reasoningEffort ?? null).toBeNull()
    const { bot } = await response.json() as { bot: { id: string } }
    fixture.ownBot(bot.id)
    await expect.poll(() => fixture.readBot(bot.id)).toMatchObject({ runtime, modelName: null, reasoningEffort: null })
    const evidence = info.outputPath("persisted-source.json")
    writeFileSync(evidence, JSON.stringify({ request, bot: await fixture.readBot(bot.id) }, null, 2))
    await info.attach("persisted-source", { path: evidence, contentType: "application/json" })
    await expect(dialog).toBeHidden()
  })
}

test("editing a legacy codex bot preserves its original source binding", async ({ caseActors, caseResources }, info) => {
  const actors = await caseActors(["alice"])
  const fixture = await prepareMachine(actors, caseResources)
  const name = `Legacy ${randomUUID().slice(0, 8)}`
  const created = await fixture.call("/api/community/bots", "POST", { name, machineId: fixture.machineId, runtime: "codex" })
  expect(created.status).toBe(201)
  const { bot } = await created.json() as { bot: { id: string } }
  fixture.ownBot(bot.id)
  const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" })
  await gotoAfterUserWsAuth(page, "/c/me/bots")
  const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) })
  await card.getByRole("button", { name: "Bot actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0)
  const dialog = page.getByRole("dialog", { name: `Edit ${name}`, exact: true })
  const picker = dialog.getByTestId(tid.botProviderPicker)
  await expect(picker.getByRole("radio")).toHaveCount(3)
  await expect(picker.getByRole("radio", { name: "Codex (automatic)", exact: true })).toBeChecked()
  await dialog.getByPlaceholder("Name your bot").fill(`${name} edited`)
  await screenshot(page, info, "legacy-codex-preserved")
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/community/bots/${bot.id}` && response.request().method() === "PATCH")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  const response = await pending
  expect(response.ok()).toBe(true)
  const request = response.request().postDataJSON() as Record<string, unknown>
  expect(request).not.toHaveProperty("runtime")
  await expect.poll(() => fixture.readBot(bot.id)).toMatchObject({ name: `${name} edited`, runtime: "codex" })
  const evidence = info.outputPath("persisted-legacy-binding.json")
  writeFileSync(evidence, JSON.stringify({ request, bot: await fixture.readBot(bot.id) }, null, 2))
  await info.attach("persisted-legacy-binding", { path: evidence, contentType: "application/json" })
  await expect(dialog).toBeHidden()
})
