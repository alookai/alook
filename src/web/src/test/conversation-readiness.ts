export type ConversationTarget = {
  pathname: string
  channelId: string
  serverId?: string
  kind: "text" | "thread" | "dm" | "forum"
  messageTestId?: string
  forumPostTestId?: string
  empty?: boolean
  layout?: "mobile-detail"
}

export type ConversationInspectionTarget = ConversationTarget & {
  testIds: { channelSidebarScroll: string; composerInput: string; forumPostList: string; pendingMainPrefix: string; messagePrefix: string }
}

export function inspectConversationReadiness(target: ConversationInspectionTarget) {
  const blockers: string[] = []
  const inspect = (node: Element | null) => {
    if (!node) return { visible: false, opacity: 0, inert: false, blocked: false }
    let opacity = 1
    let hidden = false
    let inert = false
    let blocked = false
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      opacity *= Number(style.opacity || 1)
      hidden ||= style.display === "none" || ["hidden", "collapse"].includes(style.visibility)
      inert ||= ancestor.hasAttribute("inert")
      blocked ||= style.pointerEvents === "none" || ancestor.getAttribute("aria-disabled") === "true"
    }
    const rect = node.getBoundingClientRect()
    return { visible: !hidden && opacity > 0 && rect.width > 0 && rect.height > 0, opacity, inert, blocked }
  }
  const usable = (node: Element | null) => {
    const state = inspect(node)
    return state.visible && state.opacity === 1 && !state.inert && !state.blocked
  }
  if (location.pathname !== target.pathname) blockers.push("wrong-route")
  const identityPath = target.kind === "dm" ? `/c/me/${target.channelId}` : `/c/channels/${target.serverId}/${target.channelId}`
  if (target.pathname !== identityPath) blockers.push("inconsistent-target-identity")
  let mobileMain: Element | undefined
  let retainedSidebar: Element | undefined
  if (target.layout === "mobile-detail") {
    const mains = Array.from(document.querySelectorAll('[data-slot="community-main-panel-content"][data-community-mobile-surface="detail"]')).filter(usable)
    const main = mains.length === 1 ? mains[0] : undefined
    const panelSelector = '[data-slot="resizable-panel"]'
    const groupSelector = '[data-slot="resizable-panel-group"]'
    const shellSelector = '[data-slot="community-shell-root"]'
    const mainPanel = main?.closest(panelSelector)
    const group = mainPanel?.closest(groupSelector)
    const shell = group?.closest(shellSelector)
    const panels = Array.from(group?.querySelectorAll(panelSelector) ?? [])
      .filter((panel) => panel.closest(groupSelector) === group && panel.closest(shellSelector) === shell)
    const sidePanels = panels.filter((panel) => panel.id === "sidebar")
    const sidePanel = sidePanels.length === 1 ? sidePanels[0] : undefined
    const contents = Array.from(sidePanel?.querySelectorAll('[data-slot="community-sidebar-panel-content"]') ?? [])
    const sidebar = contents.length === 1 ? contents[0] : undefined
    const mainContents = Array.from(group?.querySelectorAll('[data-slot="community-main-panel-content"]') ?? [])
    const qualified = window.matchMedia("(max-width: 639px)").matches
      && !!main && !!shell && group?.id === "community-shell" && mainPanel?.id === "main"
      && panels.filter((panel) => panel.id === "main").length === 1 && mainContents.length === 1
      && mainPanel.getAttribute("data-mobile-active") === "true"
      && mainPanel.getAttribute("data-mobile-hidden") !== "true"
      && main.closest(groupSelector) === group && main.closest(shellSelector) === shell
      && sidebar?.hasAttribute("hidden") === true && sidebar.closest(panelSelector) === sidePanel
      && sidePanel?.getAttribute("data-mobile-hidden") === "true"
      && sidePanel.getAttribute("data-mobile-active") !== "true"
      && sidebar.closest(groupSelector) === group && sidebar.closest(shellSelector) === shell
    if (!qualified) blockers.push("wrong-mobile-detail-layout")
    else { mobileMain = main; retainedSidebar = sidebar! }
  }
  const scopeRoot = target.layout === "mobile-detail" ? retainedSidebar : document
  const owners = Array.from(scopeRoot?.querySelectorAll("[data-community-channel-tree-scope]") ?? [])
  const matchingOwners = owners.filter((owner) => owner.getAttribute("data-community-channel-tree-scope") === `server:${target.serverId}`)
  const validOwner = (owner: Element) => {
    const scrolls = Array.from(owner.querySelectorAll(`[data-testid="${target.testIds.channelSidebarScroll}"]`))
    return target.layout === "mobile-detail"
      ? owners.length === 1 && matchingOwners.length === 1 && scrolls.length === 1
        && scrolls[0].closest("[data-community-channel-tree-scope]") === owner
        && owner.closest('[data-slot="community-sidebar-panel-content"]') === retainedSidebar
        && scrolls[0].closest('[data-slot="community-sidebar-panel-content"]') === retainedSidebar
        && owner.closest('[data-slot="resizable-panel"]') === retainedSidebar?.closest('[data-slot="resizable-panel"]')
        && scrolls[0].closest('[data-slot="resizable-panel"]') === retainedSidebar?.closest('[data-slot="resizable-panel"]')
      : scrolls.some((sidebar) => sidebar.closest("[data-community-channel-tree-scope]") === owner && usable(sidebar))
  }
  if (target.serverId && !matchingOwners.some(validOwner)) blockers.push("wrong-server-scope")
  const contentRoot = target.layout === "mobile-detail" ? mobileMain : document
  const masks = document.querySelectorAll([
    `[data-testid^="${target.testIds.pendingMainPrefix}"]`,
    "[data-community-unresolved-main]",
    "[data-pending-server-id]",
    "[data-message-list-skeleton]",
    "[data-message-positioning-skeleton]",
    '[data-slot="community-main-panel-content"] [data-slot="skeleton"]',
    `[data-testid="${target.testIds.forumPostList}"] [data-slot="skeleton"]`,
  ].join(","))
  if (Array.from(masks).some((node) => inspect(node).visible)) blockers.push("visible-mask")
  if (Array.from(document.querySelectorAll('[data-slot="community-shell-root"]'))
    .some((node) => node.getAttribute("aria-busy") === "true" && inspect(node).visible)) blockers.push("busy-shell")
  if (target.kind === "forum") {
    const lists = contentRoot?.querySelectorAll(`[data-testid="${target.testIds.forumPostList}"]`) ?? []
    if (lists.length !== 1 || lists[0].getAttribute("role") !== "main" || !usable(lists[0])) blockers.push("forum-list-unusable")
    const posts = Array.from(lists[0]?.querySelectorAll('div[role="button"][tabindex="0"][data-testid]') ?? [])
      .filter((node) => node.getAttribute("data-testid") === target.forumPostTestId && node.closest(`[data-testid="${target.testIds.forumPostList}"]`) === lists[0])
    if (!target.forumPostTestId || posts.length !== 1 || !usable(posts[0])) blockers.push("expected-forum-post-missing")
  } else {
    const surfaces = Array.from(contentRoot?.querySelectorAll('[data-slot="community-conversation-surface"]') ?? [])
      .filter((node) => node.getAttribute("data-channel-id") === target.channelId)
    if (surfaces.length !== 1 || !usable(surfaces[0])) blockers.push("wrong-conversation-surface")
    const surface = surfaces[0]
    const content = surface?.querySelector("[data-message-list-content]") ?? null
    if (content?.getAttribute("data-initial-position-phase") !== "revealed" || !usable(content)) {
      blockers.push("content-not-revealed")
    }
    if (target.messageTestId) {
      const message = Array.from(surface?.querySelectorAll("[data-testid]") ?? [])
        .find((node) => node.getAttribute("data-testid") === target.messageTestId) ?? null
      if (!usable(message)) blockers.push("expected-message-missing")
    } else if (target.empty) {
      if (!usable(content?.querySelector("h2") ?? null)
        || !content?.textContent?.includes("Beginning of the channel.")
        || content.querySelector(`[data-testid^="${target.testIds.messagePrefix}"]`)) blockers.push("empty-contract-missing")
    } else blockers.push("content-identity-unspecified")
    const composer = surface?.querySelector(`[data-testid="${target.testIds.composerInput}"] [contenteditable="true"]`) ?? null
    if (!usable(composer) || composer?.hasAttribute("disabled")) blockers.push("composer-unusable")
  }
  return { ready: blockers.length === 0, blockers, pathname: location.pathname, atPageMs: performance.now(), timeOrigin: performance.timeOrigin, scopeMode: target.layout ?? "visible-sidebar", mobileLayoutQualified: mobileMain !== undefined }
}
