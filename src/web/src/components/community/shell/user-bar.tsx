"use client"

import {
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react"
import { CircleAlert, Download, Inbox, LoaderCircle, Settings } from "lucide-react"
import { Avatar } from "../avatar"
import { Skeleton } from "@/components/ui/skeleton"
import type { MachineSummary } from "@/hooks/community/use-machines"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { Presence } from "@/lib/community/models/people"
import type { Breakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { CommunityInboxSurface } from "./community-inbox-surface"
import { UserBarExtensionSlot } from "./user-bar-extension-slot"
import type {
  UserBarExtensionKind,
  UserBarUpdatePhase,
  UserBarUpdateState,
} from "./user-bar-extension-state"

type UserBarExtension = {
  active: UserBarExtensionKind
  inbox: ReactNode
  profile: ReactNode
  update: UserBarUpdateState | null
  updateBadgePhase: Exclude<UserBarUpdatePhase, "expanded"> | null
  eligibleMachines: readonly MachineSummary[]
  onOpenUpdate: () => void
  onRequestUpdate: () => void
  onDismiss: () => void
}

export function UserBar({ breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, inboxOpen, onInboxOpenChange, extension }: {
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread: boolean
  inboxOpen?: boolean
  onInboxOpenChange?: (open: boolean) => void
  extension?: UserBarExtension
}) {
  const inboxAnchorRef = useRef<HTMLDivElement>(null)
  const profileTriggerRef = useRef<HTMLButtonElement>(null)
  const profileNameTriggerRef = useRef<HTMLButtonElement>(null)
  const lastProfileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const inboxTriggerRef = useRef<HTMLButtonElement>(null)
  const updateBadgeRef = useRef<HTMLButtonElement>(null)
  const [pendingExtensionFocus, setPendingExtensionFocus] = useState<UserBarExtensionKind>("none")
  const suppressInboxFocusReturnRef = useRef(false)
  const closeInboxForAction = () => {
    suppressInboxFocusReturnRef.current = true
    if (inboxOpen) onInboxOpenChange?.(false)
  }
  const dismissExtensionWithFocus = () => {
    if (!extension || extension.active === "none") return
    const active = extension.active
    extension.onDismiss()
    globalThis.requestAnimationFrame(() => {
      if (active === "inbox") inboxTriggerRef.current?.focus()
      else if (active === "profile") {
        (lastProfileTriggerRef.current ?? profileTriggerRef.current)?.focus()
      }
      else updateBadgeRef.current?.focus()
    })
  }
  return (
    <div
      data-testid={tid.userBar}
      className="w-full min-w-0 max-w-full shrink-0 overflow-hidden pl-[max(0.75rem,var(--app-safe-area-left))] pr-[max(0.75rem,var(--app-safe-area-right))] pb-[calc(0.75rem+var(--app-safe-area-bottom))] pt-0 sm:px-3 sm:pb-3"
    >
      {extension && extension.active !== "none" && (
        <UserBarExtensionSlot
          active={extension.active}
          inbox={extension.inbox}
          profile={extension.profile}
          update={extension.update}
          eligibleMachines={extension.eligibleMachines}
          onDismiss={dismissExtensionWithFocus}
          onDismissOutside={extension.onDismiss}
          onRequestUpdate={extension.onRequestUpdate}
          focusOnOpen={pendingExtensionFocus === extension.active}
          onInitialFocus={() => {
            if (pendingExtensionFocus === extension.active) {
              setPendingExtensionFocus("none")
            }
          }}
        />
      )}
      <div
        ref={inboxAnchorRef}
        data-slot="community-user-bar-base"
        className={cn(
          "flex h-12 items-center gap-3 border border-border/40 bg-muted px-4",
          (extension && extension.active !== "none") || (breakpoint === "mobile" && inboxOpen)
            ? "rounded-b-xl"
            : "rounded-xl",
        )}
      >
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
          profileTriggerRef={profileTriggerRef}
          profileNameTriggerRef={profileNameTriggerRef}
          lastProfileTriggerRef={lastProfileTriggerRef}
          inboxTriggerRef={inboxTriggerRef}
          updateBadgeRef={updateBadgeRef}
          onRequestExtensionFocus={setPendingExtensionFocus}
          extension={extension}
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
      <div className="flex h-12 items-center gap-3 rounded-xl border border-border/40 bg-muted px-4">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <Skeleton className="h-3.5 min-w-0 flex-1 rounded" />
        <Skeleton className="size-7 shrink-0 rounded-lg" />
        <Skeleton className="size-7 shrink-0 rounded-lg" />
      </div>
    </div>
  )
}

function Inner({ breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, inboxOpen, onInboxOpenChange, inboxAnchorRef, suppressInboxFocusReturnRef, closeInboxForAction, profileTriggerRef, profileNameTriggerRef, lastProfileTriggerRef, inboxTriggerRef, updateBadgeRef, onRequestExtensionFocus, extension }: {
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread: boolean
  inboxOpen?: boolean
  onInboxOpenChange?: (open: boolean) => void
  inboxAnchorRef: RefObject<HTMLDivElement | null>
  suppressInboxFocusReturnRef: MutableRefObject<boolean>
  closeInboxForAction: () => void
  profileTriggerRef: RefObject<HTMLButtonElement | null>
  profileNameTriggerRef: RefObject<HTMLButtonElement | null>
  lastProfileTriggerRef: MutableRefObject<HTMLButtonElement | null>
  inboxTriggerRef: RefObject<HTMLButtonElement | null>
  updateBadgeRef: RefObject<HTMLButtonElement | null>
  onRequestExtensionFocus: (extension: UserBarExtensionKind) => void
  extension?: UserBarExtension
}) {
  const mobile = breakpoint === "mobile"
  const updateBadgeLabel = extension?.updateBadgePhase === "retry"
    ? "Retry machine update"
    : extension?.updateBadgePhase === "updating"
      ? "Machine update in progress"
      : "Open machine update"
  const UpdateBadgeIcon = extension?.updateBadgePhase === "retry"
    ? CircleAlert
    : extension?.updateBadgePhase === "updating"
      ? LoaderCircle
      : Download
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button ref={profileTriggerRef} onClick={(e) => {
        lastProfileTriggerRef.current = e.currentTarget
        if (extension && extension.active !== "profile") {
          onRequestExtensionFocus("profile")
        }
        if (!extension) closeInboxForAction()
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-expanded={extension ? extension.active === "profile" : undefined} aria-controls={extension?.active === "profile" ? "community-user-bar-extension" : undefined}>
        <Avatar label={user.avatar} seed={user.id} size={28} presence={user.presence} ringColor="var(--muted)" />
      </button>
      <button ref={profileNameTriggerRef} onClick={(e) => {
        lastProfileTriggerRef.current = e.currentTarget
        if (extension && extension.active !== "profile") {
          onRequestExtensionFocus("profile")
        }
        if (!extension) closeInboxForAction()
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className="min-w-0 flex-1 text-left rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-expanded={extension ? extension.active === "profile" : undefined} aria-controls={extension?.active === "profile" ? "community-user-bar-extension" : undefined}>
        <div data-testid={tid.userBarName} className="truncate text-sm font-medium leading-tight">{user.name}</div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {extension?.updateBadgePhase && (
          <button
            ref={updateBadgeRef}
            type="button"
            data-testid={tid.daemonUpdateBadge}
            className="grid size-11 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7"
            aria-label={updateBadgeLabel}
            onClick={() => {
              onRequestExtensionFocus("update")
              extension.onOpenUpdate()
            }}
          >
            <UpdateBadgeIcon className={cn(
              "size-4",
              extension.updateBadgePhase === "updating" && "animate-spin motion-reduce:animate-none",
            )} />
          </button>
        )}
        {inbox && extension ? (
          <button
            ref={inboxTriggerRef}
            type="button"
            data-testid={tid.inboxTrigger}
            className={cn(
              "relative grid size-11 place-items-center rounded-lg text-muted-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7",
              mobile
                ? "hover:text-foreground active:text-foreground"
                : "hover:bg-accent hover:text-foreground",
            )}
            aria-label={mobile ? (inboxOpen ? "Close Inbox" : "Open Inbox") : "Inbox"}
            aria-expanded={inboxOpen}
            aria-pressed={mobile ? inboxOpen : undefined}
            aria-controls={inboxOpen ? "community-user-bar-extension" : undefined}
            onClick={() => {
              if (!inboxOpen) onRequestExtensionFocus("inbox")
              onInboxOpenChange?.(!inboxOpen)
            }}
          >
            <span className="relative grid size-4 place-items-center">
              <Inbox className="size-4" />
              {hasUnread && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary" />}
            </span>
          </button>
        ) : inbox ? (
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
        ) : null}
        <button
          onClick={() => {
            if (extension) extension.onDismiss()
            else closeInboxForAction()
            onEditProfile?.()
          }}
          className={cn(
            "grid size-11 place-items-center rounded-lg text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7",
            breakpoint === "mobile"
              ? "hover:text-foreground active:text-foreground"
              : "hover:bg-accent hover:text-foreground",
          )}
          aria-label="User settings"
          data-testid={tid.userSettingsOpen}
        >
          <Settings className="size-4" />
        </button>
      </div>
    </div>
  )
}
