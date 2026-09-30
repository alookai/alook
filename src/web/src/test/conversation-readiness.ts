export type ConversationTarget = {
  pathname: string
  channelId: string
  serverId?: string
  kind: "text" | "thread" | "dm" | "forum"
  messageTestId?: string
  forumPostTestId?: string
  empty?: boolean
}

export type ConversationInspectionTarget = ConversationTarget & {
  testIds: { composerInput: string; forumPostList: string; pendingMainPrefix: string; messagePrefix: string }
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
  if (target.serverId && !Array.from(document.querySelectorAll("[data-community-channel-tree-scope]"))
    .some((node) => node.getAttribute("data-community-channel-tree-scope") === `server:${target.serverId}` && usable(node))) {
    blockers.push("wrong-server-scope")
  }
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
    const lists = document.querySelectorAll(`[data-testid="${target.testIds.forumPostList}"]`)
    if (lists.length !== 1 || !usable(lists[0])) blockers.push("forum-list-unusable")
    const post = Array.from(lists[0]?.querySelectorAll("[data-testid]") ?? [])
      .find((node) => node.getAttribute("data-testid") === target.forumPostTestId) ?? null
    if (!target.forumPostTestId || !usable(post)) blockers.push("expected-forum-post-missing")
  } else {
    const surfaces = Array.from(document.querySelectorAll('[data-slot="community-conversation-surface"]'))
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
  return { ready: blockers.length === 0, blockers, pathname: location.pathname, atPageMs: performance.now(), timeOrigin: performance.timeOrigin }
}
