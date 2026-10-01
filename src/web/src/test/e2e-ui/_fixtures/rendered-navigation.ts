import { expect, type Page, type TestInfo } from "@playwright/test"
import { inspectConversationReadiness, type ConversationTarget } from "../../conversation-readiness"
import { tid } from "./testids"

export type RenderedFrame = {
  atEpochMs: number; mainOwned?: boolean; pathname: string; headers: string[]; conversations: string[]
  forum: boolean; forumPosts: string[]; forumRoles?: Array<{ id: string; role: string }>; neutral: boolean; unresolved?: Array<{ role: string; kind: string | null; subtype: string | null; owned: boolean }>; pending: Array<{ kind: string; subtype: string | null }>
  scopes: Array<{ scope: string; owner: number; owned?: boolean; visible: boolean; rows: string[] }>
  cold: Array<{ serverId: string; owned?: boolean; width: number; right: number; rows: string[]; owner: number | null }>
  lists: string[]; mobile: Array<{ surface: string; transform: string; opacity: string }>
  dmLists?: Array<{ owned: boolean; visible: boolean; rows: string[]; state: string; width: number; height: number }>
}
export type RenderedObservation = {
  timeOrigin: number; action: { atEpochMs: number; kind: string; trusted: boolean } | null
  stoppedAt: number | null; frames: RenderedFrame[]; animations: string[]
}
export type RenderedContract = {
  paths: string[]; finalPath: string; channelId?: string; header?: string; headers?: string[]; companionChannelIds?: string[]; forum?: boolean; forumPostTestId?: string
  scopes: string[]; finalScope?: string; allowedRows?: string[]; forbiddenRows?: string[]
  pendingKind?: string; subtype?: string; stationary?: boolean; listStates?: string[]
  coldRoot?: { serverId: string; rootPath: string }; allowedColdServers?: string[]; allowMeRootPending?: boolean; sourceListPath?: string; finalListState?: string; actionKind?: "trusted" | "synthetic" | "programmatic"
}

export function renderedViolations(observation: RenderedObservation, contract: RenderedContract): string[] {
  const failures: string[] = []
  const fail = (condition: boolean, message: string) => { if (condition) failures.push(message) }
  fail(!observation.action, "missing action")
  fail(observation.action?.kind !== (contract.actionKind ?? "trusted"), "wrong action kind")
  fail((contract.actionKind ?? "trusted") === "trusted" && !observation.action?.trusted, "untrusted action")
  fail(observation.frames.length === 0, "empty post-action frames")
  let typedPublished = false
  for (const frame of observation.frames) {
    fail(frame.atEpochMs <= (observation.action?.atEpochMs ?? Infinity), "frame before action")
    fail(frame.mainOwned === false, "missing/duplicate/foreign main owner")
    fail((frame.dmLists ?? []).some((list) => list.visible && !list.owned), "foreign/incomplete DM list owner")
    fail(!contract.paths.includes(frame.pathname), `wrong path ${frame.pathname}`)
    fail(frame.headers.some((title) => !(contract.headers ?? (contract.header ? [contract.header] : [])).includes(title)), "stale/wrong header")
    fail(frame.conversations.some((id) => id !== contract.channelId && !contract.companionChannelIds?.includes(id)), "stale/wrong conversation")
    if (contract.forumPostTestId) fail(frame.forumPosts.some((id) => id !== contract.forumPostTestId), "wrong forum post")
    typedPublished ||= frame.headers.length > 0 || frame.conversations.length > 0 || frame.forum
      || frame.pending.some((pending) => pending.kind === "server-conversation" && ["text", "forum", "thread"].includes(pending.subtype ?? ""))
    const unresolved = frame.unresolved ?? []
    const root = contract.coldRoot
    const targetCold = root && frame.cold.length === 1 && frame.cold[0].serverId === root.serverId
      && frame.cold[0].owned === true && frame.cold[0].owner === null && frame.cold[0].rows.length === 0
    const targetTree = root && frame.scopes.length === 1 && frame.scopes[0].owned === true && frame.scopes[0].scope === `server:${root.serverId}`
    const coldRootAllowed = !!root && !typedPublished && unresolved.length === 1 && unresolved[0].owned
      && ((frame.pathname === root.rootPath && ["direct-server-landing", "segment-loading", "wrapped-server-landing"].includes(unresolved[0].role) && (targetCold || targetTree))
        || (frame.pathname !== root.rootPath && contract.paths.includes(frame.pathname) && targetCold && unresolved[0].role === "wrapped-server-landing"))
    const meRootAllowed = contract.allowMeRootPending && unresolved.length === 1 && unresolved[0].owned
      && unresolved[0].role === "me-root" && frame.pending.some((pending) => pending.kind === "me-root")
    fail(frame.neutral && !coldRootAllowed && !meRootAllowed, "wrong neutral conversation")
    fail((frame.forumRoles ?? []).some((entry) => entry.role === "unclassified"), "unclassified/foreign forum prefix")
    fail(new Set(frame.forumPosts).size !== frame.forumPosts.length, "duplicate forum card")
    fail(frame.cold.some((cold) => !contract.allowedColdServers?.includes(cold.serverId)), "wrong cold checkpoint")
    fail(frame.cold.some((cold) => cold.owner !== null || cold.rows.length > 0), "cold checkpoint borrowed rows/owner")
    fail(frame.scopes.some((scope) => scope.owned === false), "foreign structural owner")
    fail(frame.cold.some((cold) => cold.owned === false), "foreign cold owner")
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
      fail(!hasTarget && frame.pending.length === 0 && !allowedSourceList && !coldRootAllowed, "missing rendered checkpoint/target")
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

export function installRenderedNavigation({ selector, actionKind, sidebarId, rowPrefix, dmRowPrefix, pairId, forumId, forumPostPrefix }: { selector: string | null; actionKind: "trusted" | "synthetic" | "programmatic"; sidebarId: string; rowPrefix: string; dmRowPrefix: string; pairId: string; forumId: string; forumPostPrefix: string }) {
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
      const panel = main?.closest('[data-slot="resizable-panel"]')
      const group = panel?.closest('[data-slot="resizable-panel-group"]')
      const shell = group?.closest('[data-slot="community-shell-root"]')
      const ownedMain = !!main && panel?.id === "main" && group?.id === "community-shell" && !!shell
        && document.querySelectorAll('[data-slot="community-main-panel-content"]').length === 1
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
      const scopes = owners.map((owner) => {
        const sidebarPanel = owner.closest('[data-slot="resizable-panel"]')
        const content = owner.closest('[data-slot="community-sidebar-panel-content"]')
        const sameOwner = (node: Element) => node.closest("[data-community-channel-tree-scope]") === owner
          && node.closest('[data-slot="resizable-panel"]') === sidebarPanel
          && node.closest('[data-slot="community-sidebar-panel-content"]') === content
          && node.closest('[data-slot="resizable-panel-group"]') === group && node.closest('[data-slot="community-shell-root"]') === shell
        const scrolls = Array.from(owner.querySelectorAll(`[data-testid="${sidebarId}"]`))
        const ownerRows = Array.from(owner.querySelectorAll(`[data-testid^="${rowPrefix}"]`))
        const owned = ownedMain && sidebarPanel?.id === "sidebar" && !!content
          && owner.closest('[data-slot="resizable-panel-group"]') === group && owner.closest('[data-slot="community-shell-root"]') === shell
          && scrolls.length === 1 && scrolls.every(sameOwner) && ownerRows.every(sameOwner)
        return { scope: owner.dataset.communityChannelTreeScope!, owner: ownerId(owner), owned,
          visible: scrolls.some((sidebar) => sameOwner(sidebar) && visible(sidebar)), rows: rows(owner, owner) }
      })
      const cold = Array.from(document.querySelectorAll<HTMLElement>("[data-pending-server-id]")).filter(visible).map((node) => {
        const rect = node.getBoundingClientRect(); const panel = node.closest('[data-slot="community-sidebar-panel-content"]')
        const owner = panel?.querySelector("[data-community-channel-tree-scope]") ?? null
        return { serverId: node.dataset.pendingServerId!, owned: ownedMain && !!panel
          && node.closest('[data-slot="resizable-panel"]')?.id === "sidebar" && node.closest('[data-slot="resizable-panel-group"]') === group
          && node.closest('[data-slot="community-shell-root"]') === shell, width: rect.width, right: rect.right, rows: rows(panel ?? node), owner: owner ? ownerId(owner) : null }
      })
      const lists: string[] = []
      const dmLists = location.pathname === "/c/me" && innerWidth < 640
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dm-sidebar-list"]')).filter(visible).map((node) => {
          const sidebar = node.closest('[data-slot="community-sidebar-panel-content"]')
          const aside = node.closest("aside")
          const shortcuts = Array.from(aside?.querySelectorAll('[data-slot="dm-sidebar-shortcuts"]') ?? [])
          const surfaces = mobile.filter((surface) => surface.dataset.communityMobileSurface === "list" && sidebar?.contains(surface))
          const sameOwner = (element: Element) => element.closest('[data-slot="community-sidebar-panel-content"]') === sidebar
          const dmRows = Array.from(node.querySelectorAll<HTMLElement>(`[data-testid^="${dmRowPrefix}"]`)).filter(visible)
          const empty = Array.from(node.querySelectorAll("p")).some((paragraph) => visible(paragraph)
            && paragraph.textContent?.trim() === "Your direct messages will appear here.")
          const loading = Array.from(node.querySelectorAll('[data-slot="skeleton"]')).some(visible)
          const state = dmRows.length > 0 ? "rows" : empty ? "empty" : loading ? "pending" : "unknown"
          const owned = ownedMain && !!sidebar && node.closest('[data-slot="resizable-panel"]')?.id === "sidebar"
            && node.closest('[data-slot="resizable-panel-group"]') === group && node.closest('[data-slot="community-shell-root"]') === shell
            && shortcuts.length === 1 && shortcuts.every((shortcut) => sameOwner(shortcut) && visible(shortcut))
            && surfaces.length === 1 && (surfaces[0] === sidebar || surfaces[0].contains(node))
            && state !== "unknown" && dmRows.every((row) => sameOwner(row) && row.closest("aside") === aside)
          const rect = node.getBoundingClientRect()
          return { owned, visible: true, rows: dmRows.map((row) => row.dataset.testid!), state,
            width: rect.width, height: rect.height }
        }) : []
      for (const list of dmLists) if (list.owned) lists.push(list.state === "pending" ? "dms-pending" : "dms")
      if (Array.from(document.querySelectorAll('input[placeholder="Search friends"]')).some(visible)) lists.push("friends")
      if (Array.from(document.querySelectorAll(`[data-testid="${pairId}"]`)).some(visible)) lists.push("machines")
      if (Array.from(main?.querySelectorAll('[aria-label="Loading friends"]') ?? []).some(visible)) lists.push("friends-pending")
      if (!lists.includes("machines") && Array.from(main?.querySelectorAll('[data-slot="community-machines-heading"]') ?? []).some(visible)) lists.push("machines-pending")
      if (pending.some((node) => node.kind === "me-root")) lists.push("me-pending")
      if (scopes.some((scope) => scope.visible)) lists.push("server")
      const unresolved = Array.from(main?.querySelectorAll<HTMLElement>("[data-community-unresolved-main]") ?? []).filter(visible).map((node) => {
        const kind = node.closest("[data-community-main-kind]")?.getAttribute("data-community-main-kind") ?? null
        const subtype = node.closest("[data-community-conversation-subtype]")?.getAttribute("data-community-conversation-subtype") ?? null
        const roleNode = node.closest('[aria-busy="true"][aria-label]')
        const label = roleNode?.getAttribute("aria-label")
        const role = label === "Loading server" && roleNode?.tagName === "MAIN" && !subtype && (kind === null || kind === "server-landing")
          ? kind === "server-landing" ? "wrapped-server-landing" : "direct-server-landing"
          : label === "Loading conversation" && roleNode?.tagName === "DIV" && !kind && !subtype ? "segment-loading"
          : label === "Resolving conversation" && subtype === "unknown" ? "unknown-conversation"
          : label === "Loading your space" && kind === "me-root" ? "me-root"
          : label === "Resolving community route" && kind === "route-resolution" ? "route-resolution" : "unclassified"
        return { role, kind, subtype, owned: ownedMain && node.closest('[data-slot="community-main-panel-content"]') === main
          && node.closest('[data-slot="resizable-panel"]') === panel && roleNode?.getAttribute("aria-busy") === "true" }
      })
      const forumLists = Array.from(main?.querySelectorAll(`[data-testid="${forumId}"]`) ?? []).filter(visible)
      const list = ownedMain && forumLists.length === 1 && forumLists[0].getAttribute("role") === "main"
        && forumLists[0].closest('[data-slot="community-main-panel-content"]') === main && forumLists[0].closest('[data-slot="resizable-panel"]') === panel
        ? forumLists[0] : null
      const prefixes = Array.from(main?.querySelectorAll<HTMLElement>(`[data-testid^="${forumPostPrefix}"]`) ?? []).filter(visible)
      const cardSelector = `div[role="button"][tabindex="0"][data-testid^="${forumPostPrefix}"]`
      const cards = prefixes.filter((node) => node.matches(cardSelector) && node.closest(`[data-testid="${forumId}"]`) === list && !!list)
      const forumRoles = prefixes.map((node) => {
        const id = node.dataset.testid!
        if (node === list) return { id, role: "container" }
        if (cards.includes(node)) return { id, role: "card" }
        const card = node.closest(cardSelector) as HTMLElement | null
        const postId = card?.dataset.testid?.slice(forumPostPrefix.length)
        const child = postId && ["title-", "title-text-", "seq-", "tag-btn-", "archive-btn-", "delete-btn-", "avatars-"].some((part) => id === `${forumPostPrefix}${part}${postId}`)
        return { id, role: child && card && cards.includes(card) && node.closest(`[data-testid="${forumId}"]`) === list ? "child" : "unclassified" }
      })
      observation.frames.push({ atEpochMs: performance.timeOrigin + performance.now(), mainOwned: ownedMain, pathname: location.pathname,
        headers: Array.from(main?.querySelectorAll('[role="banner"] [data-slot="message-header-identity"] > span[title]') ?? []).filter(visible).map((node) => node.textContent?.trim() ?? ""),
        conversations: Array.from(main?.querySelectorAll('[data-slot="community-conversation-surface"]') ?? []).filter(visible).map((node) => node.getAttribute("data-channel-id") ?? "<missing>"),
        forum: !!list,
        forumPosts: cards.map((node) => node.dataset.testid!), forumRoles, unresolved,
        neutral: Array.from(main?.querySelectorAll("[data-community-unresolved-main]") ?? []).some(visible), pending, scopes, cold, lists, dmLists,
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
      try {
        if (observation.action) await new Promise<void>((resolve) => requestAnimationFrame(() => { sample(); resolve() }))
        observation.stoppedAt = performance.timeOrigin + performance.now()
        return observation
      } finally { delete state.__renderedNavigation }
    } }
}

export async function observeRenderedNavigation(page: Page, selector: string | null, actionKind: "trusted" | "synthetic" | "programmatic" = "trusted") {
  await page.evaluate(installRenderedNavigation, { selector, actionKind, sidebarId: tid.channelSidebarScroll, rowPrefix: tid.channelRow(""), dmRowPrefix: tid.dmRow(""), pairId: tid.machinePairOpen, forumId: tid.forumPostList, forumPostPrefix: tid.forumThreadCard("") })
  let stopped: Promise<RenderedObservation> | undefined
  let cached: RenderedObservation | undefined
  const read = async () => {
    const observation = await page.evaluate(() => (window as typeof window & { __renderedNavigation?: { observation: RenderedObservation } }).__renderedNavigation?.observation)
    if (!observation) throw new Error("UNAVAILABLE: navigation observation")
    cached = observation
    return observation
  }
  return {
    frames: async () => (await read()).frames,
    cached: () => cached,
    checkpoint: read,
    stop: () => {
      stopped ??= page.evaluate(async () => {
        const state = window as typeof window & { __renderedNavigation?: { stop: () => Promise<RenderedObservation> } }
        if (!state.__renderedNavigation) throw new Error("UNAVAILABLE: missing navigation observer")
        return state.__renderedNavigation.stop()
      }).then((observation) => { cached = observation; return observation })
      return stopped
    },
  }
}

export async function captureReadyConversation(page: Page, target: ConversationTarget, testInfo: TestInfo, name: string) {
  const inspection = { ...target, testIds: { channelSidebarScroll: tid.channelSidebarScroll, composerInput: tid.composerInput,
    forumPostList: tid.forumPostList, pendingMainPrefix: tid.pendingMain(""), messagePrefix: tid.message("") } }
  let before: ReturnType<typeof inspectConversationReadiness> | undefined
  let after: ReturnType<typeof inspectConversationReadiness> | undefined
  let image: Buffer | undefined
  let viewport: ReturnType<Page["viewportSize"]> | undefined
  await withOwnedCleanup(name, async () => {
    before = await page.evaluate(inspectConversationReadiness, inspection)
    expect(before.blockers).toEqual([])
    viewport = page.viewportSize()
    image = await page.screenshot()
    after = await page.evaluate(inspectConversationReadiness, inspection)
    expect(after.blockers).toEqual([])
  }, [
    { name: "capture-ledger", run: () => testInfo.attach(`${name}-capture`, { body: JSON.stringify({ target, viewport, before, after,
      available: { before: !!before, image: !!image, after: !!after }, qualified: !!before && !!image && !!after && before.ready && after.ready,
      qualification: "ready checks bracket passive screenshot, not an exact earlier decision instant" }), contentType: "application/json" }) },
    { name: "capture-image", run: async () => { if (image) await testInfo.attach(name, { body: image, contentType: "image/png" }) } },
  ], testInfo)
}

export async function runRenderedNavigation(page: Page, testInfo: TestInfo, name: string, selector: string | null, contract: RenderedContract, action: (probe: Awaited<ReturnType<typeof observeRenderedNavigation>>) => Promise<void>) {
  const probe = await observeRenderedNavigation(page, selector, contract.actionKind)
  let observation: RenderedObservation | undefined
  await withOwnedCleanup(name, async () => {
    await action(probe)
    await probe.checkpoint()
  }, [
    { name: "observer-stop", run: async () => { observation = await probe.stop() } },
    { name: "observation-ledger", run: () => testInfo.attach(name, { body: JSON.stringify({ contract, observation: observation ?? probe.cached(),
      stopped: !!observation, availability: observation ? "complete" : probe.cached() ? "partial-cached" : "UNAVAILABLE",
      boundary: "finite post-action rAF observations; not all compositor frames" }), contentType: "application/json" }) },
    { name: "rendered-assertion", run: () => { if (!observation) throw new Error("UNAVAILABLE: required stopped observation"); expect(renderedViolations(observation, contract)).toEqual([]) } },
  ], testInfo)
  return observation!
}

export type RouteOwnerQualification = {
  pageRouteOwners: string[]
  source: string
}
export type OwnedRouteRecord = {
  id: number; purpose: string; url: string; selected: boolean | null
  enteredAt: number; releasedAt: number | null; terminalAt: number | null
  terminal: "active" | "continued" | "failed"; error?: string
}

export function createNavigationRouteManager(page: Page, qualification: RouteOwnerQualification) {
  const owner = "rendered-navigation"
  const records: OwnedRouteRecord[] = []
  const errors: Array<{ at: number; phase: string; error: string }> = []
  const active = new Map<Promise<void>, OwnedRouteRecord>()
  const gates = new Map<string, { release: () => void; wait: Promise<void>; releasedAt: number | null; operation?: Promise<void> }>()
  let nextRole = 0
  let disposal: Promise<void> | undefined
  let disposing = false
  const recordError = (phase: string, error: unknown) => {
    errors.push({ at: Date.now(), phase, error: String(error) })
  }
  const assertExclusive = () => {
    if (!qualification.source || qualification.pageRouteOwners.length !== 1 || qualification.pageRouteOwners[0] !== owner) {
      throw new Error("BLOCKED: page route removal requires proven exclusive rendered-navigation ownership")
    }
  }
  const assertHealthy = () => {
    if (errors.length) throw new AggregateError(errors.map((entry) => new Error(`${entry.phase}: ${entry.error}`)), "navigation route lifecycle failed")
  }
  const drain = async () => {
    while (active.size) await Promise.all([...active.keys()])
  }
  const release = (purpose: string): Promise<void> => {
    const gate = gates.get(purpose)
    if (!gate) return Promise.reject(new Error(`missing route gate ${purpose}`))
    if (!gate.operation) {
      gate.releasedAt = Date.now()
      gate.release()
      const pending = records.filter((record) => record.purpose === purpose && record.terminal === "active")
      gate.operation = Promise.all([...active].filter(([, record]) => record.purpose === purpose).map(([completion]) => completion)).then(() => {
        if (pending.some((record) => record.terminal === "active")) throw new Error(`route drain incomplete ${purpose}`)
        assertHealthy()
      })
    }
    return gate.operation
  }
  return {
    role: (label: string) => `${label}:${++nextRole}`,
    snapshot: () => ({ owner, qualification, at: Date.now(), disposing, records: records.map((record) => ({ ...record })), errors: errors.map((entry) => ({ ...entry })), active: active.size }),
    assertHealthy,
    release,
    register: async (input: { pattern: string; purpose: string; select: (route: import("@playwright/test").Route) => boolean; selected?: (route: import("@playwright/test").Route) => void; beforeContinue?: (record: OwnedRouteRecord) => Promise<void> }) => {
      assertExclusive()
      if (disposing) throw new Error("route registration after disposal began")
      if (!gates.has(input.purpose)) {
        let releaseGate!: () => void
        const wait = new Promise<void>((resolve) => { releaseGate = resolve })
        gates.set(input.purpose, { release: releaseGate, wait, releasedAt: null })
      }
      const gate = gates.get(input.purpose)!
      await page.route(input.pattern, async (route) => {
        const record: OwnedRouteRecord = { id: records.length + 1, purpose: input.purpose, url: route.request().url(), selected: null,
          enteredAt: Date.now(), releasedAt: null, terminalAt: null, terminal: "active" }
        records.push(record)
        let complete!: () => void
        const completion = new Promise<void>((resolve) => { complete = resolve })
        active.set(completion, record)
        let continuationAttempted = false
        try {
          record.selected = input.select(route)
          if (record.selected) { input.selected?.(route); await gate.wait }
          record.releasedAt = gate.releasedAt
          await input.beforeContinue?.(record)
          if (page.isClosed()) throw new Error("UNAVAILABLE: page closed before route continuation")
          continuationAttempted = true
          await route.continue()
          record.terminal = "continued"
        } catch (error) {
          record.terminal = "failed"; record.error = String(error)
          recordError(`callback:${input.purpose}:${record.id}`, error)
          if (!continuationAttempted) {
            try { await route.abort("failed") } catch (cleanup) { recordError(`abort:${record.id}`, cleanup) }
          }
        } finally {
          record.terminalAt = Date.now()
          active.delete(completion); complete()
        }
      })
    },
    dispose: (): Promise<void> => {
      if (!disposal) {
        disposal = (async () => {
          assertExclusive()
          disposing = true
          for (const gate of gates.values()) { gate.releasedAt ??= Date.now(); gate.release() }
          await drain()
          try { await page.unrouteAll({ behavior: "wait" }) } catch (error) { recordError("remove", error) }
          await drain()
          assertHealthy()
        })()
      }
      return disposal
    },
  }
}

export async function withOwnedCleanup<T>(name: string, action: () => Promise<T>, steps: Array<{ name: string; run: () => unknown | Promise<unknown> }>, testInfo?: Pick<TestInfo, "attach">): Promise<T> {
  const errors: Array<{ at: number; phase: string; error: unknown }> = []
  let value!: T
  try { value = await action() } catch (error) { errors.push({ at: Date.now(), phase: "primary", error }) }
  for (const step of steps) {
    try { await step.run() } catch (error) { errors.push({ at: Date.now(), phase: step.name, error }) }
  }
  if (testInfo && errors.length) {
    try { await testInfo.attach(`${name}-errors`, { body: JSON.stringify(errors.map((entry) => ({ at: entry.at, phase: entry.phase, error: String(entry.error), stack: entry.error instanceof Error ? entry.error.stack : undefined }))), contentType: "application/json" }) }
    catch (error) { errors.push({ at: Date.now(), phase: "error-attachment", error }) }
  }
  if (errors.length === 1) throw errors[0].error
  if (errors.length) throw new AggregateError(errors.map((entry) => entry.error), `${name}: ${errors.map((entry) => entry.phase).join(", ")}`, { cause: errors.find((entry) => entry.phase === "primary")?.error })
  return value
}
