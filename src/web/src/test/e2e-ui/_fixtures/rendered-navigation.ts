import { expect, type Page, type TestInfo } from "@playwright/test"
import { inspectConversationReadiness, type ConversationTarget } from "../../conversation-readiness"
import { tid } from "./testids"

export type RenderedFrame = {
  atEpochMs: number; pathname: string; headers: string[]; conversations: string[]
  forum: boolean; forumPosts: string[]; neutral: boolean; pending: Array<{ kind: string; subtype: string | null }>
  scopes: Array<{ scope: string; owner: number; visible: boolean; rows: string[] }>
  cold: Array<{ serverId: string; width: number; right: number; rows: string[]; owner: number | null }>
  lists: string[]; mobile: Array<{ surface: string; transform: string; opacity: string }>
}
export type RenderedObservation = {
  timeOrigin: number; action: { atEpochMs: number; kind: string; trusted: boolean } | null
  stoppedAt: number | null; frames: RenderedFrame[]; animations: string[]
}
export type RenderedContract = {
  paths: string[]; finalPath: string; channelId?: string; header?: string; headers?: string[]; companionChannelIds?: string[]; forum?: boolean; forumPostTestId?: string
  scopes: string[]; finalScope?: string; allowedRows?: string[]; forbiddenRows?: string[]
  pendingKind?: string; subtype?: string; stationary?: boolean; listStates?: string[]
  allowedColdServers?: string[]; allowMeRootPending?: boolean; sourceListPath?: string; finalListState?: string; actionKind?: "trusted" | "synthetic" | "programmatic"
}

export function renderedViolations(observation: RenderedObservation, contract: RenderedContract): string[] {
  const failures: string[] = []
  const fail = (condition: boolean, message: string) => { if (condition) failures.push(message) }
  fail(!observation.action, "missing action")
  fail(observation.action?.kind !== (contract.actionKind ?? "trusted"), "wrong action kind")
  fail((contract.actionKind ?? "trusted") === "trusted" && !observation.action?.trusted, "untrusted action")
  fail(observation.frames.length === 0, "empty post-action frames")
  for (const frame of observation.frames) {
    fail(frame.atEpochMs <= (observation.action?.atEpochMs ?? Infinity), "frame before action")
    fail(!contract.paths.includes(frame.pathname), `wrong path ${frame.pathname}`)
    fail(frame.headers.some((title) => !(contract.headers ?? (contract.header ? [contract.header] : [])).includes(title)), "stale/wrong header")
    fail(frame.conversations.some((id) => id !== contract.channelId && !contract.companionChannelIds?.includes(id)), "stale/wrong conversation")
    if (contract.forumPostTestId) fail(frame.forumPosts.some((id) => id !== contract.forumPostTestId), "wrong forum post")
    fail(frame.neutral && !(contract.allowMeRootPending && frame.pending.some((pending) => pending.kind === "me")), "wrong neutral conversation")
    fail(frame.cold.some((cold) => !contract.allowedColdServers?.includes(cold.serverId)), "wrong cold checkpoint")
    fail(frame.cold.some((cold) => cold.owner !== null || cold.rows.length > 0), "cold checkpoint borrowed rows/owner")
    fail(frame.scopes.some((scope) => !contract.scopes.includes(scope.scope)), "wrong structural scope")
    fail(frame.scopes.filter((scope) => scope.visible).length > 1, "simultaneous visible server trees")
    fail(frame.scopes.some((scope) => scope.scope === contract.finalScope && scope.rows.some((row) => contract.forbiddenRows?.includes(row))), "stale/wrong row")
    for (const pending of frame.pending) {
      fail(pending.kind !== contract.pendingKind && !(pending.kind === "content" && (frame.conversations.includes(contract.channelId ?? "") || (contract.forum && frame.forum))), "wrong checkpoint kind")
      if (contract.subtype && pending.kind === "server-conversation") {
        fail(pending.subtype !== contract.subtype, "wrong typed checkpoint")
      }
    }
    if (contract.stationary) {
      fail(frame.mobile.length !== 1 || frame.mobile.some((surface) => !["list", "detail"].includes(surface.surface)), "missing/multiple/wrong mobile witness")
      for (const surface of frame.mobile) {
        fail(!["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(surface.transform) || surface.opacity !== "1", "moving/faded mobile surface")
      }
    }
    if (contract.listStates) {
      fail(frame.lists.some((state) => !contract.listStates!.includes(state)), "wrong list")
      fail(frame.lists.length > 1, "simultaneous source/target lists")
      const targetContent = frame.conversations.includes(contract.channelId ?? "") || (contract.forum && frame.forum)
      const coldContent = frame.cold.some((cold) => contract.allowedColdServers?.includes(cold.serverId))
      fail(frame.lists.length === 0 && !targetContent && frame.pending.length === 0 && !coldContent, "blank list/source/target state")
    } else if (contract.channelId || contract.forum) {
      const hasTarget = frame.conversations.includes(contract.channelId ?? "") || (contract.forum && frame.forum)
      const allowedSourceList = contract.sourceListPath === frame.pathname && frame.lists.length === 1 && frame.lists[0] === "server" && frame.headers.length === 0 && frame.conversations.length === 0 && !frame.forum
      fail(frame.lists.some((list) => list !== "server"), "wrong list in detail transition")
      fail(!hasTarget && frame.pending.length === 0 && !allowedSourceList, "missing rendered checkpoint/target")
    }
  }
  if (contract.stationary) fail(observation.animations.length > 0, "surface animate called")
  const final = observation.frames.at(-1)
  fail(final?.pathname !== contract.finalPath, "wrong final path")
  if ((contract.channelId || contract.forum) && !contract.finalListState) fail((final?.pending.length ?? 1) > 0, "final target still pending")
  if (contract.channelId && !contract.finalListState) fail(!final?.conversations.includes(contract.channelId), "missing final conversation")
  if (contract.finalListState) fail(!final?.lists.includes(contract.finalListState), "missing final list surface")
  if (contract.forum) fail(!final?.forum, "missing final forum")
  if (contract.forumPostTestId) fail(!final?.forumPosts.includes(contract.forumPostTestId), "missing exact final forum post")
  if (contract.finalScope) fail(!final?.scopes.some((scope) => scope.scope === contract.finalScope && (scope.visible || (contract.stationary && final.mobile.length === 1 && final.mobile[0].surface === "detail"))), "missing final structural scope")
  if (contract.allowedRows) fail(!final?.scopes.some((scope) => contract.allowedRows!.every((row) => scope.rows.includes(row))), "missing final rows")
  return failures
}

export async function observeRenderedNavigation(page: Page, selector: string | null, actionKind: "trusted" | "synthetic" | "programmatic" = "trusted") {
  await page.evaluate(({ selector, actionKind, sidebarId, rowPrefix, pairId, forumId, forumPostPrefix }) => {
    const state = window as typeof window & { __renderedNavigation?: {
      observation: RenderedObservation; stop: () => Promise<RenderedObservation>
    }; __renderedOwnerIds?: WeakMap<Element, number>; __renderedNextOwnerId?: number }
    if (state.__renderedNavigation) throw new Error("previous navigation observer still active")
    state.__renderedOwnerIds ??= new WeakMap()
    state.__renderedNextOwnerId ??= 0
    const ownerId = (node: Element) => {
      let id = state.__renderedOwnerIds!.get(node)
      if (id === undefined) { id = ++state.__renderedNextOwnerId!; state.__renderedOwnerIds!.set(node, id) }
      return id
    }
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity || 1) === 0) return false
      }
      return true
    }
    const rows = (node: Element, owner?: Element) => Array.from(node.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}"]`))
      .filter((row) => visible(row) && (!owner || row.closest("[data-community-channel-tree-scope]") === owner)).map((row) => row.dataset.testid!.slice(rowPrefix.length))
    const observation: RenderedObservation = { timeOrigin: performance.timeOrigin, action: null, stoppedAt: null, frames: [], animations: [] }
    const sample = () => {
      const main = document.querySelector('[data-slot="community-main-panel-content"]')
      const owners = Array.from(document.querySelectorAll<HTMLElement>("[data-community-channel-tree-scope]"))
        .filter((owner) => Array.from(owner.querySelectorAll(`[data-testid="${sidebarId}"]`)).some((sidebar) => sidebar.closest("[data-community-channel-tree-scope]") === owner))
      const mobile = Array.from(document.querySelectorAll<HTMLElement>("[data-community-mobile-surface]")).filter(visible)
      const pending = Array.from(main?.querySelectorAll<HTMLElement>("[data-community-main-kind]") ?? []).filter(visible)
        .map((node) => ({ kind: node.dataset.communityMainKind!, subtype: node.querySelector("[data-community-conversation-subtype]")?.getAttribute("data-community-conversation-subtype") ?? null }))
      if (pending.length === 0 && Array.from(main?.querySelectorAll("[data-community-conversation-subtype]") ?? []).some(visible)) {
        for (const node of Array.from(main?.querySelectorAll("[data-community-conversation-subtype]") ?? []).filter(visible)) {
          pending.push({ kind: "server-conversation", subtype: node.getAttribute("data-community-conversation-subtype") })
        }
      }
      if (pending.length === 0 && Array.from(main?.querySelectorAll("[data-message-list-skeleton], [data-message-positioning-skeleton]") ?? []).some(visible)) {
        pending.push({ kind: "content", subtype: null })
      }
      const scopes = owners.map((owner) => ({ scope: owner.dataset.communityChannelTreeScope!, owner: ownerId(owner),
        visible: Array.from(owner.querySelectorAll(`[data-testid="${sidebarId}"]`)).some((sidebar) => sidebar.closest("[data-community-channel-tree-scope]") === owner && visible(sidebar)), rows: rows(owner, owner) }))
      const cold = Array.from(document.querySelectorAll<HTMLElement>("[data-pending-server-id]")).filter(visible).map((node) => {
        const rect = node.getBoundingClientRect(); const panel = node.closest('[data-slot="community-sidebar-panel-content"]')
        const owner = panel?.querySelector("[data-community-channel-tree-scope]") ?? null
        return { serverId: node.dataset.pendingServerId!, width: rect.width, right: rect.right, rows: rows(panel ?? node), owner: owner ? ownerId(owner) : null }
      })
      const lists: string[] = []
      if (Array.from(document.querySelectorAll('input[placeholder="Search friends"]')).some(visible)) lists.push("friends")
      if (Array.from(document.querySelectorAll(`[data-testid="${pairId}"]`)).some(visible)) lists.push("machines")
      if (Array.from(main?.querySelectorAll('[aria-label="Loading friends"]') ?? []).some(visible)) lists.push("friends-pending")
      if (!lists.includes("machines") && Array.from(main?.querySelectorAll('[data-slot="community-machines-heading"]') ?? []).some(visible)) lists.push("machines-pending")
      if (pending.some((node) => node.kind === "me")) lists.push("me-pending")
      if (scopes.some((scope) => scope.visible)) lists.push("server")
      observation.frames.push({ atEpochMs: performance.timeOrigin + performance.now(), pathname: location.pathname,
        headers: Array.from(main?.querySelectorAll('[role="banner"] [data-slot="message-header-identity"] > span[title]') ?? []).filter(visible).map((node) => node.textContent?.trim() ?? ""),
        conversations: Array.from(main?.querySelectorAll('[data-slot="community-conversation-surface"]') ?? []).filter(visible).map((node) => node.getAttribute("data-channel-id") ?? "<missing>"),
        forum: Array.from(main?.querySelectorAll(`[data-testid="${forumId}"]`) ?? []).some(visible),
        forumPosts: Array.from(main?.querySelectorAll<HTMLElement>(`[data-testid^="${forumPostPrefix}"]`) ?? []).filter(visible).map((node) => node.dataset.testid!),
        neutral: Array.from(main?.querySelectorAll("[data-community-unresolved-main]") ?? []).some(visible), pending, scopes, cold, lists,
        mobile: mobile.map((node) => ({ surface: node.dataset.communityMobileSurface!, transform: getComputedStyle(node).transform, opacity: getComputedStyle(node).opacity })) })
    }
    let raf = 0
    const tick = () => { sample(); raf = requestAnimationFrame(tick) }
    const begin = (trusted: boolean) => {
      if (observation.action) return
      observation.action = { atEpochMs: performance.timeOrigin + performance.now(), kind: actionKind, trusted }
      raf = requestAnimationFrame(tick)
    }
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !selector || !event.target.closest(selector)) return
      if (event.isTrusted !== (actionKind === "trusted")) return
      begin(event.isTrusted)
    }
    const nativeAnimate = Element.prototype.animate
    const animate: Element["animate"] = function (this: Element, keyframes, options) {
      if (observation.action && this.hasAttribute("data-community-mobile-surface")) observation.animations.push(this.getAttribute("data-community-mobile-surface")!)
      return nativeAnimate.call(this, keyframes, options)
    }
    Element.prototype.animate = animate
    document.addEventListener("click", onClick, true)
    if (actionKind === "programmatic") begin(false)
    state.__renderedNavigation = { observation, stop: async () => {
      document.removeEventListener("click", onClick, true); cancelAnimationFrame(raf)
      Element.prototype.animate = nativeAnimate
      if (observation.action) await new Promise<void>((resolve) => requestAnimationFrame(() => { sample(); resolve() }))
      observation.stoppedAt = performance.timeOrigin + performance.now()
      delete state.__renderedNavigation
      return observation
    } }
  }, { selector, actionKind, sidebarId: tid.channelSidebarScroll, rowPrefix: tid.channelRow(""), pairId: tid.machinePairOpen, forumId: tid.forumPostList, forumPostPrefix: tid.forumThreadCard("") })
  let stopped: RenderedObservation | undefined
  return {
    frames: () => page.evaluate(() => (window as typeof window & { __renderedNavigation?: { observation: RenderedObservation } }).__renderedNavigation?.observation.frames ?? []),
    stop: async () => {
      stopped ??= await page.evaluate(async () => {
        const state = window as typeof window & { __renderedNavigation?: { stop: () => Promise<RenderedObservation> } }
        if (!state.__renderedNavigation) throw new Error("missing navigation observer")
        return state.__renderedNavigation.stop()
      })
      return stopped
    },
  }
}

export async function captureReadyConversation(page: Page, target: ConversationTarget, testInfo: TestInfo, name: string) {
  const inspection = { ...target, testIds: { channelSidebarScroll: tid.channelSidebarScroll, composerInput: tid.composerInput,
    forumPostList: tid.forumPostList, pendingMainPrefix: tid.pendingMain(""), messagePrefix: tid.message("") } }
  const before = await page.evaluate(inspectConversationReadiness, inspection)
  expect(before.blockers).toEqual([])
  const viewport = page.viewportSize()
  const image = await page.screenshot()
  const after = await page.evaluate(inspectConversationReadiness, inspection)
  await testInfo.attach(`${name}-capture`, { body: JSON.stringify({ target, viewport, before, after, qualification: "ready checks bracket passive screenshot, not an exact earlier decision instant" }), contentType: "application/json" })
  await testInfo.attach(name, { body: image, contentType: "image/png" })
  expect(after.blockers).toEqual([])
}

export async function runRenderedNavigation(page: Page, testInfo: TestInfo, name: string, selector: string | null, contract: RenderedContract, action: (probe: Awaited<ReturnType<typeof observeRenderedNavigation>>) => Promise<void>) {
  const probe = await observeRenderedNavigation(page, selector, contract.actionKind)
  let observation: RenderedObservation
  try { await action(probe) } finally {
    observation = await probe.stop()
    await testInfo.attach(name, { body: JSON.stringify({ contract, observation, boundary: "finite post-action rAF observations; not all compositor frames" }), contentType: "application/json" })
  }
  expect(renderedViolations(observation!, contract)).toEqual([])
  return observation!
}
