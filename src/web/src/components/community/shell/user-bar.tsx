"use client"

import { Button } from "@/components/ui/button"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import {
  memo,
  useId,
  useRef,
  type RefObject,
  type ReactNode,
} from "react"
import { CircleAlert, Download, LoaderCircle, Settings } from "@/components/icons/lucide";
import { isMobile } from "@alook/shared"
import { InboxUnreadIndicator } from "./inbox-unread-indicator"
import { Avatar } from "../avatar"
import { Skeleton } from "@/components/ui/skeleton"
import type { MachineSummary } from "@/hooks/community/use-machines"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { Presence } from "@/lib/community/models/people"
import type { Breakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import {
  COMMUNITY_USER_BAR_HEIGHT_CSS,
  COMMUNITY_USER_BAR_NATIVE_MOBILE_HEIGHT_CSS,
} from "./shell-frame-geometry"
import { UserBarExtensionDrawer } from "./user-bar-extension-drawer"
import { UserBarExtensionSlot } from "./user-bar-extension-slot"
import { UserBarPopover } from "./user-bar-popover"
import { useHydratedClient } from "./use-hydrated-client"
import styles from "./user-bar.module.css"
import {
  USER_BAR_INTERACTIVE_SELECTOR,
  type UserBarExtensionKind,
  type UserBarUpdatePhase,
  type UserBarUpdateState,
} from "./user-bar-extension-state"

type UserBarExtension = {
  active: UserBarExtensionKind
  inbox: ReactNode
  profile: ReactNode
  profileCompanion?: ReactNode
  update: UserBarUpdateState | null
  updateBadgePhase: Exclude<UserBarUpdatePhase, "expanded"> | null
  eligibleMachines: readonly MachineSummary[]
  onOpenUpdate: () => void
  onRequestUpdate: () => void
  onDismiss: () => void
}

export const UserBar = memo(function UserBar({ breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, unreadCount, unreadCountPartial, inboxOpen, inboxOpening = false, onInboxOpenChange, extension }: {
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence; runningBotCount?: number }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread: boolean
  unreadCount?: number
  unreadCountPartial?: boolean
  inboxOpen?: boolean
  inboxOpening?: boolean
  onInboxOpenChange?: (open: boolean) => void
  extension?: UserBarExtension
}) {
  const nativeMobile = useHydratedClient() && isMobile()
  const userBarHeightCss = nativeMobile
    ? COMMUNITY_USER_BAR_NATIVE_MOBILE_HEIGHT_CSS
    : COMMUNITY_USER_BAR_HEIGHT_CSS
  const extensionId = useId()
  const profileTriggerRef = useRef<HTMLButtonElement>(null)
  const profileNameTriggerRef = useRef<HTMLButtonElement>(null)
  const lastProfileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const inboxTriggerRef = useRef<HTMLButtonElement>(null)
  const updateBadgeRef = useRef<HTMLButtonElement>(null)
  const baseRef = useRef<HTMLDivElement>(null)
  const [pendingExtensionFocus, setPendingExtensionFocus] = useAtom(useCreateAtom<UserBarExtensionKind>("none"))
  const mobile = breakpoint === "mobile"
  const joinedMobileExtension = mobile && (
    inboxOpen
    || Boolean(extension && extension.active !== "none")
  )
  const hasOpenExtension = Boolean(
    inboxOpen
    || inboxOpening
    || (extension && extension.active !== "none"),
  )
  const dismissOpenSlot = () => {
    setPendingExtensionFocus("none")
    if (extension && extension.active !== "none") {
      extension.onDismiss()
      return
    }
    if (inboxOpen || inboxOpening) onInboxOpenChange?.(false)
  }
  const dismissExtensionWithFocus = () => {
    if (!extension || extension.active === "none") return
    const active = extension.active
    extension.onDismiss()
    globalThis.requestAnimationFrame(() => {
      if (active === "inbox") inboxTriggerRef.current?.focus()
      else if (active === "profile") {
        const trigger = lastProfileTriggerRef.current
        const style = trigger ? getComputedStyle(trigger) : null
        const visible = trigger?.isConnected && style?.display !== "none" && style?.visibility !== "hidden"
        const focusTarget = visible ? trigger : profileTriggerRef.current
        focusTarget?.focus()
      }
      else updateBadgeRef.current?.focus()
    })
  }
  const extensionContent = extension && extension.active !== "none" ? (
    <UserBarExtensionSlot
      id={extensionId}
      active={extension.active}
      inbox={extension.inbox}
      profile={extension.profile}
      profileCompanion={mobile ? extension.profileCompanion : undefined}
      update={extension.update}
      eligibleMachines={extension.eligibleMachines}
      onDismiss={dismissExtensionWithFocus}
      onDismissOutside={extension.onDismiss}
      onRequestUpdate={extension.onRequestUpdate}
      interactive={mobile}
      presentation={mobile ? "slot" : "popup"}
      userBarHeightCss={userBarHeightCss}
      focusOnOpen={pendingExtensionFocus === extension.active}
      onInitialFocus={() => {
        if (pendingExtensionFocus === extension.active) {
          setPendingExtensionFocus("none")
        }
      }}
    />
  ) : null
  return (
    <div
      data-testid={tid.userBar}
      style={nativeMobile ? { paddingBottom: "0.25rem" } : undefined}
      className="@container/user-bar w-full min-w-0 max-w-full shrink-0 overflow-hidden px-3 pb-3 pt-0 sm:px-2 sm:pb-3"
      onClick={(e) => {
        if (extension && extension.active !== "none") return
        if (!(inboxOpen || inboxOpening)) return
        if (!(e.target instanceof Element)) return
        if (e.target.closest(`[data-testid='${tid.userBarExtension}']`)) return
        if (e.target.closest(USER_BAR_INTERACTIVE_SELECTOR)?.closest(`[data-testid='${tid.userBar}']`)) return
        dismissOpenSlot()
      }}
    >
      {mobile
        ? <UserBarExtensionDrawer onDismiss={dismissExtensionWithFocus} userBarHeightCss={userBarHeightCss}>{extensionContent}</UserBarExtensionDrawer>
        : extensionContent && extension && (
          <UserBarPopover
            anchor={baseRef}
            inbox={extension.active === "inbox"}
            companion={extension.active === "profile" ? extension.profileCompanion : undefined}
            onDismiss={extension.onDismiss}
            onEscape={dismissExtensionWithFocus}
          >
            {extensionContent}
          </UserBarPopover>
        )}
      <div
        ref={baseRef}
        data-slot="community-user-bar-base"
        className={cn(
          styles.base,
          "flex items-center gap-3 border border-border/40 bg-muted px-2",
          joinedMobileExtension
            ? "rounded-b-xl"
            : "rounded-xl",
        )}
      >
        <Inner
          extensionId={extensionId}
          breakpoint={breakpoint}
          user={user}
          onOpenProfile={onOpenProfile}
          onEditProfile={onEditProfile}
          inbox={inbox}
          hasUnread={hasUnread}
          unreadCount={unreadCount}
          unreadCountPartial={unreadCountPartial}
          inboxOpen={inboxOpen}
          inboxOpening={inboxOpening}
          onInboxOpenChange={onInboxOpenChange}
          hasOpenExtension={hasOpenExtension}
          dismissOpenSlot={dismissOpenSlot}
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
})

export function UserBarSkeleton() {
  const nativeMobile = useHydratedClient() && isMobile()
  return (
    <div
      data-testid={tid.initialUserBarPending}
      style={nativeMobile ? { paddingBottom: "0.25rem" } : undefined}
      aria-hidden
      className="@container/user-bar w-full min-w-0 max-w-full shrink-0 overflow-hidden px-3 pb-3 pt-0 sm:px-2 sm:pb-3"
    >
      <div className={cn(styles.base, "flex items-center gap-3 rounded-xl border border-border/40 bg-muted px-2")}>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:@max-[224px]/user-bar:gap-1">
          <div className={styles.target}><Skeleton className={cn(styles.visual, "rounded-full")} /></div>
          <div className={cn(styles.name, "flex min-w-0 flex-1 items-center sm:@max-[156px]/user-bar:hidden")}>
            <Skeleton className="h-3.5 w-full rounded" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className={styles.target}><Skeleton className={cn(styles.visual, "rounded-lg")} /></div>
            <div className={styles.target}><Skeleton className={cn(styles.visual, "rounded-lg")} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Inner({ extensionId, breakpoint, user, onOpenProfile, onEditProfile, inbox, hasUnread, unreadCount, unreadCountPartial, inboxOpen, inboxOpening, onInboxOpenChange, hasOpenExtension, dismissOpenSlot, profileTriggerRef, profileNameTriggerRef, lastProfileTriggerRef, inboxTriggerRef, updateBadgeRef, onRequestExtensionFocus, extension }: {
  extensionId: string
  breakpoint: Breakpoint
  user: { id: string; name: string; avatar: string; presence?: Presence; runningBotCount?: number }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: ReactNode
  hasUnread: boolean
  unreadCount?: number
  unreadCountPartial?: boolean
  inboxOpen?: boolean
  inboxOpening: boolean
  onInboxOpenChange?: (open: boolean) => void
  hasOpenExtension: boolean
  dismissOpenSlot: () => void
  profileTriggerRef: RefObject<HTMLButtonElement | null>
  profileNameTriggerRef: RefObject<HTMLButtonElement | null>
  lastProfileTriggerRef: RefObject<HTMLButtonElement | null>
  inboxTriggerRef: RefObject<HTMLButtonElement | null>
  updateBadgeRef: RefObject<HTMLButtonElement | null>
  onRequestExtensionFocus: (extension: UserBarExtensionKind) => void
  extension?: UserBarExtension
}) {
  const inboxDescriptionId = useId()
  const mobile = breakpoint === "mobile"
  const runningBotCount = user.runningBotCount ?? 0
  const hasRunningBots = runningBotCount > 0
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
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:@max-[224px]/user-bar:gap-1">
      <button ref={profileTriggerRef} onClick={(e) => {
        if (hasOpenExtension) {
          dismissOpenSlot()
          return
        }
        lastProfileTriggerRef.current = e.currentTarget
        if (extension) {
          onRequestExtensionFocus("profile")
        }
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className={cn(styles.target, "rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-muted focus-visible:outline-none sm:focus-visible:ring-offset-4")} aria-label={hasRunningBots
        ? `Open profile. ${runningBotCount} running ${runningBotCount === 1 ? "bot" : "bots"}.`
        : "Open profile"} aria-expanded={extension ? extension.active === "profile" : undefined} aria-controls={extension?.active === "profile" ? extensionId : undefined}>
        <span className={cn(styles.visual, "relative grid place-items-center rounded-full")}>
          {hasRunningBots && (
            <>
              <span
                data-testid={tid.userBarRunningBotsGlow}
                aria-hidden
                className="user-bar-running-bots-glow pointer-events-none absolute -inset-1 rounded-full opacity-40 blur-[5px] [background:conic-gradient(from_30deg,var(--running-bots-accent),var(--running-bots-primary),var(--running-bots-accent))]"
              />
              <span
                data-testid={tid.userBarRunningBotsRing}
                aria-hidden
                className="pointer-events-none absolute -inset-px rounded-full [background:conic-gradient(from_30deg,var(--running-bots-accent),var(--running-bots-primary),var(--running-bots-accent))]"
              />
            </>
          )}
          <span className="relative rounded-full">
            <Avatar label={user.avatar} seed={user.id} size={28} presence={user.presence} ringColor="var(--muted)" />
          </span>
        </span>
      </button>
      <button ref={profileNameTriggerRef} onClick={(e) => {
        if (hasOpenExtension) {
          dismissOpenSlot()
          return
        }
        lastProfileTriggerRef.current = e.currentTarget
        if (extension) {
          onRequestExtensionFocus("profile")
        }
        onOpenProfile?.(user.name, e, undefined, user.id)
      }} className={cn(styles.name, "min-w-0 flex-1 text-left rounded sm:@max-[156px]/user-bar:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")} aria-expanded={extension ? extension.active === "profile" : undefined} aria-controls={extension?.active === "profile" ? extensionId : undefined}>
        <div data-testid={tid.userBarName} className="truncate text-sm font-medium leading-tight">{user.name}</div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {extension?.updateBadgePhase && (
          <Button variant="ghost" size="icon-sm"
            ref={updateBadgeRef}
            type="button"
            data-testid={tid.daemonUpdateBadge}
            className={cn(styles.target, styles.squareButton, styles.update, "rounded-lg text-secondary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
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
          </Button>
        )}
        {inbox ? (() => {
          const effectiveUnreadCount = unreadCount ?? (hasUnread ? 1 : 0)
          const showUnreadButton = effectiveUnreadCount > 0 && !inboxOpen
          return (
          <Button variant={showUnreadButton ? "unread" : "ghost"} size="icon-sm"
            ref={inboxTriggerRef}
            type="button"
            data-testid={tid.inboxTrigger}
            className={cn(
              showUnreadButton
                ? "relative size-7 rounded-full max-sm:mx-2 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
                : cn(
                  styles.target,
                  styles.squareButton,
                  styles.inbox,
                  "rounded-lg text-muted-foreground aria-expanded:text-foreground",
                  mobile && "active:text-foreground",
                ),
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            )}
            aria-label={mobile ? (inboxOpen || inboxOpening ? "Close Inbox" : "Open Inbox") : "Inbox"}
            aria-busy={inboxOpening || undefined}
            aria-describedby={inboxDescriptionId}
            aria-expanded={inboxOpen}
            aria-pressed={mobile ? inboxOpen : undefined}
            aria-controls={inboxOpen && extension ? extensionId : undefined}
            onClick={() => {
              if (!inboxOpen && !inboxOpening) onRequestExtensionFocus("inbox")
              if (inboxOpening) onRequestExtensionFocus("none")
              onInboxOpenChange?.(!inboxOpen && !inboxOpening)
            }}
          >
            <InboxUnreadIndicator
              descriptionId={inboxDescriptionId}
              count={effectiveUnreadCount}
              partial={unreadCountPartial ?? (unreadCount === undefined && hasUnread)}
              open={Boolean(inboxOpen)}
            />
          </Button>
          )
        })() : null}
        <Button variant="ghost" size="icon-sm"
          onClick={() => {
            dismissOpenSlot()
            onEditProfile?.()
          }}
          className={cn(
            styles.target,
            styles.squareButton,
            "rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            mobile && "active:text-foreground",
          )}
          aria-label="User settings"
          data-testid={tid.userSettingsOpen}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </div>
  )
}
