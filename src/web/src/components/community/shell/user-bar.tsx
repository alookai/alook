"use client"

import {
  useRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react"
import { Settings } from "lucide-react"
import { Avatar } from "../avatar"
import { Skeleton } from "@/components/ui/skeleton"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { Presence } from "@/lib/community/models/people"
import type { Breakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { CommunityInboxSurface } from "./community-inbox-surface"

export function UserBar({ breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, inboxOpen, onInboxOpenChange }: {
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread?: boolean
  inboxOpen?: boolean
  onInboxOpenChange?: (open: boolean) => void
}) {
  const inboxAnchorRef = useRef<HTMLDivElement>(null)
  const suppressInboxFocusReturnRef = useRef(false)
  const closeInboxForAction = () => {
    suppressInboxFocusReturnRef.current = true
    if (inboxOpen) onInboxOpenChange?.(false)
  }
  return (
    <div
      data-testid={tid.userBar}
      className="w-full min-w-0 max-w-full shrink-0 overflow-hidden pl-[max(0.75rem,var(--app-safe-area-left))] pr-[max(0.75rem,var(--app-safe-area-right))] pb-[calc(0.75rem+var(--app-safe-area-bottom))] pt-0 sm:px-3 sm:pb-3"
    >
      <div ref={inboxAnchorRef} className="flex h-12 items-center gap-3 rounded-xl bg-muted px-4 ring-1 ring-border/40">
        <Inner
          breakpoint={breakpoint}
          user={user}
          onOpenProfile={onOpenProfile}
          onEditProfile={onEditProfile}
          inbox={inbox}
          hasUnread={hasUnread}
          inboxOpen={inboxOpen}
          onInboxOpenChange={onInboxOpenChange}
          inboxAnchorRef={inboxAnchorRef}
          suppressInboxFocusReturnRef={suppressInboxFocusReturnRef}
          closeInboxForAction={closeInboxForAction}
        />
      </div>
    </div>
  )
}

export function UserBarSkeleton() {
  return (
    <div
      data-testid={tid.initialUserBarPending}
      aria-hidden
      className="w-full min-w-0 max-w-full shrink-0 overflow-hidden pl-[max(0.75rem,var(--app-safe-area-left))] pr-[max(0.75rem,var(--app-safe-area-right))] pb-[calc(0.75rem+var(--app-safe-area-bottom))] pt-0 sm:px-3 sm:pb-3"
    >
      <div className="flex h-12 items-center gap-3 rounded-xl bg-muted px-4 ring-1 ring-border/40">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <Skeleton className="h-3.5 min-w-0 flex-1 rounded" />
        <Skeleton className="size-7 shrink-0 rounded-lg" />
        <Skeleton className="size-7 shrink-0 rounded-lg" />
      </div>
    </div>
  )
}

function Inner({ breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, inboxOpen, onInboxOpenChange, inboxAnchorRef, suppressInboxFocusReturnRef, closeInboxForAction }: {
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread?: boolean
  inboxOpen?: boolean
  onInboxOpenChange?: (open: boolean) => void
  inboxAnchorRef: RefObject<HTMLDivElement | null>
  suppressInboxFocusReturnRef: MutableRefObject<boolean>
  closeInboxForAction: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button onClick={(e) => {
        closeInboxForAction()
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Avatar label={user.avatar} seed={user.id} size={28} presence={user.presence} ringColor="var(--muted)" />
      </button>
      <button onClick={(e) => {
        closeInboxForAction()
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className="min-w-0 flex-1 text-left rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <div data-testid="community-user-bar-name" className="truncate text-sm font-medium leading-tight">{user.name}</div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {inbox && (
          <CommunityInboxSurface
            breakpoint={breakpoint}
            open={inboxOpen}
            onOpenChange={onInboxOpenChange}
            hasUnread={hasUnread}
            anchorRef={inboxAnchorRef}
            suppressFocusReturnRef={suppressInboxFocusReturnRef}
          >
            {inbox}
          </CommunityInboxSurface>
        )}
        <button
          onClick={() => {
            closeInboxForAction()
            onEditProfile?.()
          }}
          className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7"
          aria-label="User settings"
          data-testid={tid.userSettingsOpen}
        >
          <Settings className="size-4" />
        </button>
      </div>
    </div>
  )
}
