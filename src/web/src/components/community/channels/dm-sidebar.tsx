"use client"

import { EmptyState } from "../empty-state"
import { CommunityNavigationLink } from "../shell/community-navigation-link"
import { dmHref } from "@/lib/community/community-route"
import { memo, useCallback, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type LucideIcon } from "lucide-react";
import { Users, Ban, Monitor, Bot, Shield, CalendarDays, MessagesSquare } from "@/components/icons/lucide";
import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"
import { Avatar } from "../avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea, ScrollAreaContent, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area"
import { tid } from "@/lib/community/testids"
import type { DM } from "@/lib/community/models/people"
import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"
import { compactRequestCount } from "@/lib/community/friend-requests"
import {
  COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
  measureCommunityVirtualizerElement,
  observeCommunityVirtualizerRect,
} from "@/hooks/community/virtualizer-react-options"

const DM_ROW_ESTIMATE = 48

const DmSidebarRow = memo(function DmSidebarRow({
  dm,
  active,
  isBlocked,
  onPickDm,
}: {
  dm: DM
  active: boolean
  isBlocked: boolean
  onPickDm: (id: string) => void
}) {
  const unread = selectUnreadPresentation({
    accountUnread: dm.unread === true,
    active,
    muted: isBlocked,
  })
  const handleActivate = useCallback(() => onPickDm(dm.id), [dm.id, onPickDm])
  return (
    <CommunityNavigationLink
      data-testid={tid.dmRow(dm.id)}
      href={dmHref(dm.id)}
      active={active}
      onActivate={handleActivate}
      className={[
        "flex w-full items-center gap-3 rounded-md px-2 py-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      ].join(" ")}
    >
      <Avatar label={dm.avatar} seed={dm.userId} size={32} presence={isBlocked ? undefined : dm.status} ringColor="var(--sidebar)" />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm leading-tight text-foreground">{dm.name}</div>
        <div className="truncate text-xs leading-tight text-muted-foreground">{dm.preview}</div>
      </div>
      {isBlocked && <Ban className="size-4 shrink-0 text-destructive" />}
      {unread.showDot && <span className="size-2 shrink-0 rounded-full bg-primary" />}
    </CommunityNavigationLink>
  )
})

export const DmSidebar = memo(function DmSidebar({
  dms, activeDm, blockedUserIds, loading, onPickDm, onShowFriends, onShowMachines, onShowBots, onShowPrivacy, onShowSchedule,
  friendsActive, machinesActive, botsActive, privacyActive, scheduleActive,
  friendRequestCount = 0,
  loadError,
}: {
  dms: DM[]
  activeDm: string | null
  blockedUserIds?: Set<string>
  loading?: boolean
  loadError?: { retrying: boolean; onRetry: () => void }
  onPickDm: (id: string) => void
  onShowFriends: () => void
  onShowMachines?: () => void
  onShowBots?: () => void
  onShowPrivacy?: () => void
  onShowSchedule?: () => void
  friendsActive?: boolean
  friendRequestCount?: number
  machinesActive?: boolean
  botsActive?: boolean
  privacyActive?: boolean
  scheduleActive?: boolean
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const isFriendsActive = friendsActive ?? (activeDm === null && !machinesActive && !botsActive && !privacyActive && !scheduleActive)
  const requestCount = compactRequestCount(friendRequestCount)
  const shortcuts: Array<{
    href: string; label: string; Icon: LucideIcon; active?: boolean; onActivate: () => void
    testId?: string; ariaLabel?: string; badge?: string | null
  }> = [
    { href: "/c/me/friends", label: "Friends", Icon: Users, active: isFriendsActive, onActivate: onShowFriends,
      ariaLabel: requestCount ? `Friends, ${friendRequestCount} new requests` : "Friends", badge: requestCount },
    ...(onShowMachines ? [{ href: "/c/me/machines", label: "Machines", Icon: Monitor, active: machinesActive, onActivate: onShowMachines, testId: tid.machineGuideIntroSource }] : []),
    ...(onShowBots ? [{ href: "/c/me/bots", label: "My Bots", Icon: Bot, active: botsActive, onActivate: onShowBots }] : []),
    ...(onShowPrivacy ? [{ href: "/c/me/privacy", label: "Privacy", Icon: Shield, active: privacyActive, onActivate: onShowPrivacy }] : []),
    ...(onShowSchedule ? [{ href: "/c/me/schedule", label: "Schedule", Icon: CalendarDays, active: scheduleActive, onActivate: onShowSchedule, testId: tid.scheduleShortcut }] : []),
  ]
  const activeShortcut = shortcuts.findIndex((shortcut) => shortcut.active)
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: dms.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => DM_ROW_ESTIMATE,
    overscan: 10,
    initialRect: { width: 240, height: 600 },
    measureElement: measureCommunityVirtualizerElement,
    observeElementRect: observeCommunityVirtualizerRect,
  })
  const virtualItems = virtualizer.getVirtualItems()
  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-slot="dm-sidebar-shortcuts" className="shrink-0 px-2 pt-4">
        <div className="relative isolate flex flex-col gap-1">
          <span
            aria-hidden
            data-slot="dm-sidebar-shortcut-indicator"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-9 rounded-md bg-sidebar-accent transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)] motion-reduce:transition-none"
            style={{ transform: `translateY(${Math.max(activeShortcut, 0) * 2.5}rem)`, opacity: activeShortcut < 0 ? 0 : 1 }}
          />
          {shortcuts.map((shortcut) => (
            <CommunityNavigationLink
              key={shortcut.href}
              data-testid={shortcut.testId}
              aria-label={shortcut.ariaLabel}
              href={shortcut.href}
              prefetchMode="visible"
              active={shortcut.active}
              onActivate={shortcut.onActivate}
              className={[
                "flex h-9 w-full items-center gap-3 rounded-md px-2 text-sm font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                shortcut.active ? "text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              ].join(" ")}
            >
              <span className="flex size-8 shrink-0 items-center justify-center">
                <shortcut.Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{shortcut.label}</span>
              {shortcut.badge && (
                <span data-testid={tid.friendsShortcutBadge} className="ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
                  {shortcut.badge}
                </span>
              )}
            </CommunityNavigationLink>
          ))}
        </div>
        <div className="my-2 h-px bg-border" />
      </div>
      <ScrollAreaRoot className="flex min-h-0 flex-1 flex-col">
        <ScrollAreaViewport ref={viewportRef} data-slot="dm-sidebar-list" className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto scroll-fade-y scroll-fade-4 px-2 pb-4">
          <ScrollAreaContent className="flex min-h-full flex-1 flex-col">
            <div className="mb-2 truncate px-2 text-xs font-semibold text-muted-foreground">
              Direct Messages
            </div>
            {loadError ? (
              <ConversationResolutionErrorFrame as="div" title="Couldn't load direct messages" {...loadError} />
            ) : loading && dms.length === 0 ? (
              <DmRowsSkeleton />
            ) : dms.length === 0 ? (
              <EmptyState icon={MessagesSquare} label="Your direct messages will appear here." />
            ) : (
              <div ref={virtualizer.containerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((virtualItem) => {
                  const d = dms[virtualItem.index]
                  if (!d) return null
                  return (
                    <div
                      key={d.id}
                      data-index={virtualItem.index}
                      ref={virtualizer.measureElement}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                    >
                      <DmSidebarRow
                        dm={d}
                        active={d.id === activeDm}
                        isBlocked={blockedUserIds?.has(d.userId) ?? false}
                        onPickDm={onPickDm}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar orientation="vertical" />
      </ScrollAreaRoot>
    </aside>
  )
})

export function DmSidebarSkeleton() {
  return (
    <aside
      data-testid={tid.dmSidebarPending}
      aria-label="Loading direct messages"
      aria-busy={true}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="shrink-0 px-2 pt-4">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <div className="my-2 h-px bg-border" />
      </div>
      <ScrollArea className="flex min-h-0 flex-1 flex-col" viewportClassName="min-h-0 flex-1 scroll-fade-y scroll-fade-4 px-2 pb-4">
        <Skeleton className="mb-2 ml-2 h-3 w-24 rounded" />
        <DmRowsSkeleton />
      </ScrollArea>
    </aside>
  )
}

function DmRowsSkeleton() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/5 rounded" />
            <Skeleton className="h-3 w-4/5 rounded" />
          </div>
        </div>
      ))}
    </>
  )
}
