"use client"

import { useSelector, shallow } from "@tanstack/react-store"
import { useMemo } from "react"
import type React from "react"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useCommunityRuntime } from "./runtime"
import { createCommunityStore, type CommunityUiHandlers } from "./ui-store"

export { createCommunityStore } from "./ui-store"

export function useCommunityStore<T>(selector: (state: ReturnType<ReturnType<typeof createCommunityStore>["get"]>) => T, compare?: (a: T, b: T) => boolean) {
  return useSelector(useCommunityRuntime().ui, selector, { compare })
}

// ── Selectors ────────────────────────────────────────────────────────────────

export const useCurrentChannelId = () =>
  useCommunityStore((s) => s.currentChannelId)

export const useCurrentChannelMeta = () => useRouteChannelProjection(useCurrentChannelId()) ?? null

export function useUiHandlers() {
  const { ui } = useCommunityRuntime()
  return useMemo(() => ({
    previewImage: (image: ImagePreview) => ui.get().uiHandlers.previewImage?.(image),
    previewAttachment: (attachment: FileAttachment) => ui.get().uiHandlers.previewAttachment?.(attachment),
    openProfile: (name: string, event: React.MouseEvent, discriminator?: string, userId?: string) => ui.get().uiHandlers.openProfile?.(name, event, discriminator, userId),
    goBackMobile: () => ui.get().uiHandlers.goBackMobile?.(),
    navigatePath: (href: string) => ui.get().uiHandlers.navigatePath?.(href),
    replacePath: (href: string) => ui.get().uiHandlers.replacePath?.(href),
    jumpToSeq: (seq: number) => ui.get().uiHandlers.jumpToSeq?.(seq),
    cancelPendingNavigation: () => ui.get().uiHandlers.cancelPendingNavigation?.(),
    navigate: (serverId: string, channelId?: string) => ui.get().uiHandlers.navigate?.(serverId, channelId),
    openMessageContext: (target: Parameters<NonNullable<CommunityUiHandlers["openMessageContext"]>>[0]) => ui.get().uiHandlers.openMessageContext?.(target),
  }), [ui])
}

export const usePendingMachineTokenId = () =>
  useCommunityStore((s) => s.pendingMachineTokenId)

// Module-scoped stable empty array — avoids allocating a fresh `[]` on every
// selector run for the common no-typing case.
const EMPTY_TYPING: string[] = []
// Stable empty object for the no-typing case, so `useShallow` doesn't churn.
const EMPTY_TYPING_NAMES: Record<string, string | null> = {}

/**
 * The userIds currently typing in a given conversation scope (`dm:<id>` /
 * `ch:<id>`), or an empty array. `useShallow` compares the returned array
 * element-wise, so a page only re-renders when THIS scope's membership
 * changes — typing activity in other conversations doesn't churn it.
 */
export const useTypingUsersForScope = (scopeKey: string) =>
  useCommunityStore(
    (s) => {
      const map = s.typingByScope.get(scopeKey)
      return map ? Array.from(map.keys()) : EMPTY_TYPING
    }, shallow,
  )

/**
 * The display names the typing events carried for a scope, keyed by userId
 * (`null` when the event didn't include one). Consumers prefer this name and
 * fall back to roster resolution only when it's absent — the fix for
 * "Unknown member is typing" when the typer isn't in the loaded roster page.
 * Returned as a plain object so `useShallow` can compare it entry-wise.
 */
export const useTypingNamesForScope = (scopeKey: string) =>
  useCommunityStore(
    (s) => {
      const map = s.typingByScope.get(scopeKey)
      if (!map) return EMPTY_TYPING_NAMES
      const out: Record<string, string | null> = {}
      for (const [id, name] of map) out[id] = name
      return out
    }, shallow,
  )
