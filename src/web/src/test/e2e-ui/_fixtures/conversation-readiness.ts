import { expect, type Page, type Request, type Response, type TestInfo } from "@playwright/test"
import { inspectConversationReadiness, type ConversationTarget } from "../../conversation-readiness"
import { withOwnedCleanup } from "./rendered-navigation"
import { tid } from "./testids"

export function observeConversationTransport(page: Page) {
  const requests = new Map<Request, {
    pathname: string; query: string; method: string; purpose: "rsc" | "api"; prefetch: boolean
    at: number; status?: number; responseAt?: number; terminalAt?: number
    terminal: "pending" | "finished" | "failed"; failure?: string
  }>()
  const errors: string[] = []
  const onRequest = (request: Request) => {
    const url = new URL(request.url())
    const headers = request.headers()
    const rsc = headers.rsc === "1"
    if (!rsc && !url.pathname.startsWith("/api/community/")) return
    requests.set(request, {
      pathname: url.pathname, query: url.search, method: request.method(), purpose: rsc ? "rsc" : "api",
      prefetch: !!(headers["next-router-prefetch"] || headers["next-router-segment-prefetch"]),
      at: Date.now(), terminal: "pending",
    })
  }
  const onResponse = (response: Response) => {
    const record = requests.get(response.request())
    if (record) { record.status = response.status(); record.responseAt = Date.now() }
    if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
  }
  const onFinished = (request: Request) => {
    const record = requests.get(request)
    if (record) { record.terminal = "finished"; record.terminalAt = Date.now() }
  }
  const onFailed = (request: Request) => {
    const record = requests.get(request)
    if (record) { record.terminal = "failed"; record.terminalAt = Date.now(); record.failure = request.failure()?.errorText ?? "unknown" }
  }
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") errors.push(message.text())
  }
  const onError = (error: Error) => { errors.push(error.message) }
  page.on("request", onRequest)
  page.on("response", onResponse)
  page.on("requestfinished", onFinished)
  page.on("requestfailed", onFailed)
  page.on("console", onConsole)
  page.on("pageerror", onError)
  return {
    snapshot: () => ({ clock: "Unix epoch milliseconds", observedUntil: Date.now(), requests: [...requests.values()], errors: [...errors] }),
    assertHealthy: () => {
      expect(errors).toEqual([])
      expect([...requests.values()].filter((record) => record.status !== undefined && (
        record.purpose === "rsc" ? record.status !== 200 : record.status < 200 || record.status >= 300
      ))).toEqual([])
    },
    targetRsc: (serverId: string, since: number) => [...requests.values()]
      .filter((record) => record.at >= since && record.purpose === "rsc" && record.pathname.startsWith(`/c/channels/${serverId}/`)),
    stop: () => {
      page.off("request", onRequest); page.off("response", onResponse)
      page.off("requestfinished", onFinished); page.off("requestfailed", onFailed)
      page.off("console", onConsole); page.off("pageerror", onError)
    },
  }
}

export async function expectConversationReady(page: Page, target: ConversationTarget, testInfo: TestInfo, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  const inspectionTarget = { ...target, testIds: {
    channelSidebarScroll: tid.channelSidebarScroll, composerInput: tid.composerInput, forumPostList: tid.forumPostList,
    pendingMainPrefix: tid.pendingMain(""), messagePrefix: tid.message(""),
  } }
  let emptyProof: { status: number; at: number; channelId: string; count: number; latestSeq: number; hasMore: boolean } | undefined
  let decisionState: ReturnType<typeof inspectConversationReadiness> | undefined
  let decisionReceivedAt: number | undefined
  let accepted = false
  let lateState: ReturnType<typeof inspectConversationReadiness> | undefined
  await withOwnedCleanup("consumer-readiness", async () => {
    await expect.poll(async () => (await page.evaluate(inspectConversationReadiness, inspectionTarget)).blockers,
      { timeout: Math.max(1, deadline - Date.now()), message: `Consumer readiness: ${target.pathname}` }).toEqual([])
    if (target.kind !== "forum") {
      const composer = page.locator(`[data-slot="community-conversation-surface"][data-channel-id="${target.channelId}"]`)
        .getByTestId(tid.composerInput).locator('[contenteditable="true"]')
      await composer.click({ trial: true, timeout: Math.max(1, deadline - Date.now()) })
      await composer.focus({ timeout: Math.max(1, deadline - Date.now()) })
      await expect(composer).toBeFocused({ timeout: Math.max(1, deadline - Date.now()) })
    }
    expect((await page.evaluate(inspectConversationReadiness, inspectionTarget)).blockers).toEqual([])
    if (target.empty && target.kind !== "forum") {
      const response = await page.request.get(`/api/community/channels/${target.channelId}/messages`, { timeout: Math.max(1, deadline - Date.now()) })
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.messages).toEqual([])
      expect(body.hasMore).toBe(false)
      expect(body.latestSeq).toBe(0)
      expect(body.surfaceReceipt.channelId).toBe(target.channelId)
      emptyProof = { status: response.status(), at: Date.now(), channelId: body.surfaceReceipt.channelId, count: body.messages.length, latestSeq: body.latestSeq, hasMore: body.hasMore }
    }
    decisionState = await page.evaluate(inspectConversationReadiness, inspectionTarget)
    decisionReceivedAt = Date.now()
    expect(decisionReceivedAt, "consumer readiness deadline includes final decision sample").toBeLessThanOrEqual(deadline)
    expect(decisionState.blockers).toEqual([])
    accepted = true
  }, [
    { name: "late-inspection", run: async () => { if (decisionState === undefined) lateState = await page.evaluate(inspectConversationReadiness, inspectionTarget) } },
    { name: "readiness-attachment", run: () => testInfo.attach("consumer-readiness", {
      body: JSON.stringify({ target, deadline, emptyProof, accepted, decisionState, decisionReceivedAt, lateState,
        lateStateAvailability: decisionState ? "not-needed" : lateState ? "available" : "UNAVAILABLE" }), contentType: "application/json",
    }) },
  ], testInfo)
}
