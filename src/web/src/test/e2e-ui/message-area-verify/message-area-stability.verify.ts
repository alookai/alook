import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page } from "@playwright/test"
import { WEB_URL } from "../_setup/paths"
import { communityFixtureFetch } from "../_fixtures/business-contract"
import { expect, test } from "../_fixtures/case-fixture"
import { gotoAfterUserWsAuth, ignoreNextDevToolsPointerCapture } from "../_fixtures/actions"
import { holdRoute } from "../_fixtures/held-route"
import { retrySeedRequest } from "../_fixtures/seed-retry"
import { tid } from "../_fixtures/testids"
import {
  STABILITY_PROBE_INIT_SCRIPT,
  evaluateStabilityThresholds,
  type StabilityScenarioMetrics,
  type StabilitySurfaceKind,
} from "./stability-probe"

type ProbeHandle = {
  start: (input: {
    scenario: string
    surface: StabilitySurfaceKind
    channelId: string
    scopeSelector?: string | null
    phase?: string
    measureShift?: boolean
  }) => void
  setPhase: (phase: string, measureShift?: boolean) => void
  stop: () => StabilityScenarioMetrics | null
}

async function startProbe(
  page: Page,
  input: {
    scenario: string
    surface: StabilitySurfaceKind
    channelId: string
    scopeSelector?: string | null
    phase?: string
    measureShift?: boolean
  },
) {
  await page.evaluate((options) => {
    const api = (window as unknown as { __alookMessageAreaStabilityProbe?: ProbeHandle })
      .__alookMessageAreaStabilityProbe
    if (!api) throw new Error("Stability probe is not installed")
    api.start(options)
  }, input)
}

async function setProbePhase(page: Page, phase: string, measureShift = true) {
  await page.evaluate(({ nextPhase, nextMeasureShift }) => {
    const api = (window as unknown as { __alookMessageAreaStabilityProbe?: ProbeHandle })
      .__alookMessageAreaStabilityProbe
    api?.setPhase(nextPhase, nextMeasureShift)
  }, { nextPhase: phase, nextMeasureShift: measureShift })
}

async function stopProbe(page: Page): Promise<StabilityScenarioMetrics> {
  const result = await page.evaluate(() => {
    const api = (window as unknown as { __alookMessageAreaStabilityProbe?: ProbeHandle })
      .__alookMessageAreaStabilityProbe
    if (!api) throw new Error("Stability probe is not installed")
    return api.stop()
  })
  if (!result) throw new Error("Stability probe returned no metrics")
  return result
}

async function waitForSurfaceSettled(page: Page, channelId: string, expectedMessageId: string) {
  const surface = page.locator(
    `[data-slot="community-conversation-surface"][data-channel-id="${channelId}"]`,
  )
  await expect(surface.getByTestId(tid.messageScroller)).toBeVisible({ timeout: 20_000 })
  await expect(surface.getByTestId(tid.message(expectedMessageId))).toBeVisible({ timeout: 20_000 })
  const content = surface.locator("[data-message-list-content]")
  await expect(content).toHaveAttribute("data-read-position-ready", "true", { timeout: 20_000 })
  await page.waitForTimeout(350)
}

async function waitForForumListSettled(page: Page, expectedPostId: string, scopeSelector?: string) {
  const scope = scopeSelector ? page.locator(scopeSelector) : page
  const list = scope.getByTestId(tid.forumPostList)
  await expect(list).toBeVisible({ timeout: 20_000 })
  await expect(list.getByTestId(tid.forumThreadCard(expectedPostId))).toBeVisible({ timeout: 20_000 })
  const content = list.locator("[data-message-list-content]")
  await expect(content).toHaveAttribute("data-read-position-ready", "true", { timeout: 20_000 })
  await page.waitForTimeout(350)
}

async function seedSequential(
  count: number,
  create: (index: number) => Promise<string>,
): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push(await create(index))
  }
  return ids
}

async function setForumPostTags(cookie: string, threadId: string, tags: readonly string[]) {
  const detailResponse = await retrySeedRequest(() =>
    communityFixtureFetch(`${WEB_URL}/api/community/channels/${threadId}`, {
      headers: { Cookie: cookie, Origin: WEB_URL },
    }),
  )
  if (!detailResponse.ok) {
    throw new Error(`GET /api/community/channels/${threadId} failed (${detailResponse.status})`)
  }
  const detail = (await detailResponse.json()) as { parentMessageId?: string | null; channel?: { parentMessageId?: string | null } }
  const openerMessageId = detail.parentMessageId ?? detail.channel?.parentMessageId
  if (!openerMessageId) {
    throw new Error(`Forum post ${threadId} missing parentMessageId`)
  }
  const tagResponse = await retrySeedRequest(() =>
    communityFixtureFetch(`${WEB_URL}/api/community/messages/${openerMessageId}/tags`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: WEB_URL,
      },
      body: JSON.stringify({ tags }),
    }),
  )
  if (!tagResponse.ok) {
    throw new Error(`PUT /api/community/messages/${openerMessageId}/tags failed (${tagResponse.status})`)
  }
}

test("message area & forum stability before/after video capture across Text, DM, Thread, Forum List, and Forum Post", async ({
  caseActors,
  caseResources,
}, testInfo) => {
  test.setTimeout(300_000)

  const mode = process.env.ALOOK_VERIFY_MODE === "assert" ? "assert" : "baseline"
  const outDir = resolve(process.env.ALOOK_VERIFY_OUT_DIR || resolve(process.cwd(), "test-results/message-area-verify"))
  const browserName = testInfo.project.name
  const videoDir = resolve(outDir, "raw-videos", browserName)
  mkdirSync(videoDir, { recursive: true })

  const actors = await caseActors(["alice", "bob"])
  const { asUser, sessionCookie, userId, seed, seedHistory } = actors

  const stamp = Date.now()
  const serverId = await seed.seedServer("alice", `Verify Area ${stamp}`)
  const alphaId = await seed.seedChannel("alice", serverId, `alpha-${stamp}`)
  const betaId = await seed.seedChannel("alice", serverId, `beta-${stamp}`)
  const forumId = await seed.seedChannel("alice", serverId, `forum-${stamp}`, "forum")
  await seed.seedJoinServer("alice", "bob", serverId)

  const alphaIds = await seedHistory(
    alphaId,
    Array.from({ length: 36 }, (_, index) => ({
      author: index % 2 === 0 ? "alice" : "bob",
      content: `Alpha history row ${index + 1} (${stamp}) — verifying stable layout height and cached switch continuity.`,
    })),
  )
  const betaIds = await seedSequential(12, (index) =>
    seed.seedMessage(
      index % 2 === 0 ? "bob" : "alice",
      betaId,
      `Beta history row ${index + 1} (${stamp}) — secondary channel for cached return switch.`,
    ),
  )

  const dmId = await seed.seedDm("alice", userId("bob"))
  const dmIds = await seedSequential(22, (index) =>
    seed.seedDmMessage(
      index % 2 === 0 ? "alice" : "bob",
      dmId,
      `DM history row ${index + 1} (${stamp}) — testing DM cache switch, vertical history scrolling, and live peer append continuity across slow network revalidation.`,
    ),
  )

  const threadAnchorId = alphaIds[alphaIds.length - 3]!
  const threadId = await seed.seedThread("alice", threadAnchorId, `Thread verify ${stamp}`)
  const threadIds = await seedSequential(12, (index) =>
    seed.seedMessage(
      index % 2 === 0 ? "alice" : "bob",
      threadId,
      `Thread reply ${index + 1} (${stamp}) — testing ThreadOpener hydration and switch stability.`,
    ),
  )

  const aliceCookie = sessionCookie("alice")
  const forumPost1Id = await seed.seedForumThread(
    "alice",
    forumId,
    `Forum Bug Report ${stamp}`,
    `Detailed bug report body for forum post 1 (${stamp}) — verifies ForumPost opener and split-view right pane stability.`,
  )
  await setForumPostTags(aliceCookie, forumPost1Id, ["bug"])
  const forumPost1Replies = await seedSequential(8, (index) =>
    seed.seedMessage(
      index % 2 === 0 ? "bob" : "alice",
      forumPost1Id,
      `Forum post 1 discussion reply ${index + 1} (${stamp}).`,
    ),
  )

  const forumPost2Id = await seed.seedForumThread(
    "alice",
    forumId,
    `Forum Design Proposal ${stamp}`,
    `Detailed design proposal body for forum post 2 (${stamp}) — verifies switching posts retains left ForumPostList.`,
  )
  await setForumPostTags(aliceCookie, forumPost2Id, ["design"])
  const forumPost2Replies = await seedSequential(6, (index) =>
    seed.seedMessage(
      index % 2 === 0 ? "bob" : "alice",
      forumPost2Id,
      `Forum post 2 discussion reply ${index + 1} (${stamp}).`,
    ),
  )

  const forumPost3Id = await seed.seedForumThread(
    "alice",
    forumId,
    `Forum Triage Notes ${stamp}`,
    `Additional bug-tagged post (${stamp}) so tag filter switching keeps multiple cards visible.`,
  )
  await setForumPostTags(aliceCookie, forumPost3Id, ["bug"])

  const { context, page } = await asUser("bob", {
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  })
  const video = page.video()

  await page.addInitScript({ content: STABILITY_PROBE_INIT_SCRIPT })

  const scenarios: StabilityScenarioMetrics[] = []

  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${alphaId}`)
  await ignoreNextDevToolsPointerCapture(page)
  await waitForSurfaceSettled(page, alphaId, alphaIds[alphaIds.length - 1]!)

  await page.getByTestId(tid.channelRow(betaId)).click()
  await waitForSurfaceSettled(page, betaId, betaIds[betaIds.length - 1]!)

  await page.getByTestId(tid.homeButton).click()
  await page.getByTestId(tid.dmRow(dmId)).click()
  await waitForSurfaceSettled(page, dmId, dmIds[dmIds.length - 1]!)

  await page.getByTestId(tid.serverIcon(serverId)).click()
  await page.getByTestId(tid.channelRow(alphaId)).click()
  await waitForSurfaceSettled(page, alphaId, alphaIds[alphaIds.length - 1]!)
  await page.getByTestId(tid.threadIndicator(threadAnchorId)).click()
  await waitForSurfaceSettled(page, threadId, threadIds[threadIds.length - 1]!)

  await page.getByTestId(tid.channelRow(forumId)).click()
  await waitForForumListSettled(page, forumPost1Id)
  await page.getByTestId(tid.forumTagChip("bug")).click()
  await waitForForumListSettled(page, forumPost3Id)
  await page.getByTestId(tid.forumTagAll).click()
  await waitForForumListSettled(page, forumPost2Id)

  await page.getByTestId(tid.forumThreadTitle(forumPost1Id)).click()
  await waitForSurfaceSettled(page, forumPost1Id, forumPost1Replies[forumPost1Replies.length - 1]!)
  await page
    .getByTestId(tid.threadSplitParent)
    .getByTestId(tid.forumThreadTitle(forumPost2Id))
    .click()
  await waitForSurfaceSettled(page, forumPost2Id, forumPost2Replies[forumPost2Replies.length - 1]!)

  await page.getByTestId(tid.channelRow(betaId)).click()
  await waitForSurfaceSettled(page, betaId, betaIds[betaIds.length - 1]!)

  const alphaHold = await holdRoute(
    page,
    (url) =>
      url.pathname === `/api/community/channels/${alphaId}/entry`
      || url.pathname === `/api/community/channels/${alphaId}/messages`,
    caseResources,
  )
  await startProbe(page, {
    scenario: "cached-text-switch-slow-reconcile",
    surface: "text",
    channelId: alphaId,
    phase: "cached-entry-held",
    measureShift: true,
  })
  await page.getByTestId(tid.channelRow(alphaId)).click()
  await page.waitForTimeout(900)
  await setProbePhase(page, "reconcile-release", true)
  await alphaHold.release()
  await waitForSurfaceSettled(page, alphaId, alphaIds[alphaIds.length - 1]!)
  const liveTextId = await seed.seedMessage("alice", alphaId, `Live peer message in alpha (${stamp})`)
  await expect(
    page
      .locator(`[data-slot="community-conversation-surface"][data-channel-id="${alphaId}"]`)
      .getByTestId(tid.message(liveTextId)),
  ).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(450)
  scenarios.push(await stopProbe(page))

  const dmHold = await holdRoute(
    page,
    (url) =>
      url.pathname === `/api/community/channels/${dmId}/entry`
      || url.pathname === `/api/community/channels/${dmId}/messages`,
    caseResources,
  )
  await startProbe(page, {
    scenario: "cached-dm-switch-and-history-append",
    surface: "dm",
    channelId: dmId,
    phase: "cached-dm-held",
    measureShift: true,
  })
  await page.getByTestId(tid.homeButton).click()
  await page.getByTestId(tid.dmRow(dmId)).click()
  await page.waitForTimeout(900)
  await setProbePhase(page, "dm-reconcile-release", true)
  await dmHold.release()
  await waitForSurfaceSettled(page, dmId, dmIds[dmIds.length - 1]!)

  await setProbePhase(page, "user-scroll-up", false)
  const dmScroller = page
    .locator(`[data-slot="community-conversation-surface"][data-channel-id="${dmId}"]`)
    .getByTestId(tid.messageScroller)
  await dmScroller.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 420)
  })
  await page.waitForTimeout(300)

  await setProbePhase(page, "reading-history-live-append", true)
  await seed.seedDmMessage("alice", dmId, `Live DM while reading history (${stamp})`)
  await page.waitForTimeout(800)
  scenarios.push(await stopProbe(page))

  await page.getByTestId(tid.serverIcon(serverId)).click()
  await page.getByTestId(tid.channelRow(alphaId)).click()
  await waitForSurfaceSettled(page, alphaId, liveTextId)

  const threadHold = await holdRoute(
    page,
    (url) =>
      url.pathname === `/api/community/channels/${threadId}/entry`
      || url.pathname === `/api/community/channels/${threadId}/messages`
      || url.pathname === `/api/community/messages/${threadAnchorId}`,
    caseResources,
  )
  await startProbe(page, {
    scenario: "cached-text-thread-opener-slow-reconcile",
    surface: "thread",
    channelId: threadId,
    phase: "cached-thread-held",
    measureShift: true,
  })
  await page.getByTestId(tid.threadIndicator(threadAnchorId)).click()
  await page.waitForTimeout(900)
  await setProbePhase(page, "thread-reconcile-release", true)
  await threadHold.release()
  await waitForSurfaceSettled(page, threadId, threadIds[threadIds.length - 1]!)
  scenarios.push(await stopProbe(page))

  await page.getByTestId(tid.channelRow(betaId)).click()
  await waitForSurfaceSettled(page, betaId, betaIds[betaIds.length - 1]!)

  const forumListHold = await holdRoute(
    page,
    (url) =>
      url.pathname === `/api/community/channels/${forumId}/entry`
      || url.pathname === `/api/community/channels/${forumId}/threads`,
    caseResources,
  )
  await startProbe(page, {
    scenario: "cached-forum-list-switch-and-tag-filter",
    surface: "forum-list",
    channelId: forumId,
    phase: "cached-forum-entry-held",
    measureShift: true,
  })
  await page.getByTestId(tid.channelRow(forumId)).click()
  await page.waitForTimeout(900)
  await setProbePhase(page, "forum-reconcile-release", true)
  await forumListHold.release()
  await waitForForumListSettled(page, forumPost1Id)

  await setProbePhase(page, "forum-tag-switch-to-bug", false)
  await page.getByTestId(tid.forumTagChip("bug")).click()
  await waitForForumListSettled(page, forumPost3Id)
  await setProbePhase(page, "forum-tag-bug-settled", true)
  await page.waitForTimeout(350)

  await setProbePhase(page, "forum-tag-switch-to-all", false)
  await page.getByTestId(tid.forumTagAll).click()
  await waitForForumListSettled(page, forumPost2Id)
  await setProbePhase(page, "forum-tag-all-settled", true)
  await page.waitForTimeout(350)
  scenarios.push(await stopProbe(page))

  const forumPostHold = await holdRoute(
    page,
    (url) =>
      url.pathname === `/api/community/channels/${forumPost1Id}/entry`
      || url.pathname === `/api/community/channels/${forumPost1Id}/messages`,
    caseResources,
  )
  await startProbe(page, {
    scenario: "cached-forum-post-detail-split-slow-reconcile",
    surface: "forum-post",
    channelId: forumPost1Id,
    scopeSelector: `[data-testid="${tid.threadSplitPanel}"]`,
    phase: "cached-forum-post-held",
    measureShift: true,
  })
  await page.getByTestId(tid.forumThreadTitle(forumPost1Id)).click()
  await page.waitForTimeout(900)
  await setProbePhase(page, "forum-post-reconcile-release", true)
  await forumPostHold.release()
  await waitForSurfaceSettled(page, forumPost1Id, forumPost1Replies[forumPost1Replies.length - 1]!)
  scenarios.push(await stopProbe(page))

  await startProbe(page, {
    scenario: "forum-split-parent-retention-on-post-switch",
    surface: "forum-list",
    channelId: forumId,
    scopeSelector: `[data-testid="${tid.threadSplitParent}"]`,
    phase: "split-parent-post-switch",
    measureShift: true,
  })
  await page
    .getByTestId(tid.threadSplitParent)
    .getByTestId(tid.forumThreadTitle(forumPost2Id))
    .click()
  await waitForSurfaceSettled(page, forumPost2Id, forumPost2Replies[forumPost2Replies.length - 1]!)
  await page.waitForTimeout(350)
  scenarios.push(await stopProbe(page))

  await caseResources.closeContext(context)

  const webmPath = resolve(outDir, `${browserName}-message-area-${mode}.webm`)
  if (video) {
    await video.saveAs(webmPath)
  }

  const thresholdCheck = evaluateStabilityThresholds(scenarios)
  const report = {
    browser: browserName,
    mode,
    recordedAt: new Date().toISOString(),
    webmPath: video ? webmPath : null,
    passed: thresholdCheck.passed,
    violations: thresholdCheck.violations,
    scenarios,
  }
  const reportPath = resolve(outDir, `${browserName}-report.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  await testInfo.attach(`stability-report-${browserName}`, {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  })

  if (mode === "assert") {
    expect(thresholdCheck.violations, `Stability violations on ${browserName}`).toEqual([])
  }
})
