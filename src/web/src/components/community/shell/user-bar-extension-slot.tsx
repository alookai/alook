"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { CircleAlert, Download, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { MachineSummary } from "@/hooks/community/use-machines"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { COMMUNITY_USER_BAR_HEIGHT_CSS } from "./shell-frame-geometry"
import type {
  UserBarExtensionKind,
  UserBarUpdateState,
} from "./user-bar-extension-state"

const EXTERNAL_INTERACTIVE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

type Props = {
  active: Exclude<UserBarExtensionKind, "none">
  inbox?: ReactNode
  profile?: ReactNode
  update: UserBarUpdateState | null
  eligibleMachines: readonly MachineSummary[]
  onDismiss: () => void
  onDismissOutside?: () => void
  onRequestUpdate: () => void
  focusOnOpen?: boolean
  onInitialFocus?: () => void
}

export function UserBarExtensionSlot({
  active,
  inbox,
  profile,
  update,
  eligibleMachines,
  onDismiss,
  onDismissOutside = onDismiss,
  onRequestUpdate,
  focusOnOpen = false,
  onInitialFocus,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      onDismiss()
    }
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      if (ref.current?.contains(event.target)) return
      if (event.target.closest(`[data-testid='${tid.userBar}']`)) return
      if (event.target.closest(EXTERNAL_INTERACTIVE_SELECTOR)) onDismissOutside()
      else onDismiss()
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("click", onClick)
    }
  }, [onDismiss, onDismissOutside])

  useEffect(() => {
    if (!focusOnOpen) return
    ref.current?.focus()
    onInitialFocus?.()
  }, [active, focusOnOpen, onInitialFocus])

  const title = active === "inbox"
    ? "Inbox"
    : active === "profile"
      ? "Your profile"
      : "Machine update"

  return (
    <div
      ref={ref}
      id="community-user-bar-extension"
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-testid={tid.userBarExtension}
      data-extension={active}
      tabIndex={-1}
      className={cn(
        "relative min-h-0 origin-bottom overflow-hidden rounded-t-xl border-x border-t border-border/40 bg-popover text-popover-foreground shadow-(--e2) [clip-path:inset(-2rem_-2rem_0)]",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150",
        active === "inbox" && "flex flex-col",
      )}
      style={{
        maxHeight: `min(28rem, max(0px, calc(100dvh - ${COMMUNITY_USER_BAR_HEIGHT_CSS} - var(--app-safe-area-top))))`,
        height: active === "inbox"
          ? `min(28rem, max(0px, calc(100dvh - ${COMMUNITY_USER_BAR_HEIGHT_CSS} - var(--app-safe-area-top))))`
          : undefined,
      }}
    >
      {active === "inbox" && inbox}
      {active === "profile" && (
        <div className="overflow-y-auto thin-scrollbar p-2">{profile}</div>
      )}
      {active === "update" && update && (
        <DaemonUpdateExtension
          update={update}
          eligibleMachines={eligibleMachines}
          onRequestUpdate={onRequestUpdate}
        />
      )}
    </div>
  )
}

function DaemonUpdateExtension({
  update,
  eligibleMachines,
  onRequestUpdate,
}: {
  update: UserBarUpdateState
  eligibleMachines: readonly MachineSummary[]
  onRequestUpdate: () => void
}) {
  const accepted = new Set(update.acceptedMachineIds)
  const pending = new Set(update.pendingMachineIds)
  const updatingCount = update.targetMachineIds.filter((machineId) => (
    accepted.has(machineId) || pending.has(machineId)
  )).length
  const retryCount = update.failedMachineIds.length
  const initialCount = update.targetMachineIds.length
  const activeCount = updatingCount || initialCount
  const unavailable = new Set([
    ...update.acceptedMachineIds,
    ...update.failedMachineIds,
    ...update.pendingMachineIds,
  ])
  const availableCount = update.targetMachineIds.filter((machineId) => (
    !unavailable.has(machineId)
  )).length
  const updating = update.phase === "updating" || update.pendingMachineIds.length > 0
  const retry = update.phase === "retry"
  const description = retry
    ? updatingCount > 0
      ? `${updatingCount} ${updatingCount === 1 ? "machine is" : "machines are"} updating. ${retryCount} update ${retryCount === 1 ? "request" : "requests"} failed.`
      : `${retryCount} update ${retryCount === 1 ? "request" : "requests"} failed.`
    : updating
      ? availableCount > 0
        ? `${updatingCount} ${updatingCount === 1 ? "machine is" : "machines are"} updating. ${availableCount} ${availableCount === 1 ? "machine is" : "machines are"} ready to update.`
        : `${activeCount} ${activeCount === 1 ? "machine is" : "machines are"} updating. This will disappear when they report the new version.`
      : initialCount === 1
        ? "You can update your machine to get more features."
        : "You can update your machines to get more features."
  const Icon = retry ? CircleAlert : updating ? LoaderCircle : Download

  return (
    <div data-testid={tid.daemonUpdateNotice} className="flex min-h-36 flex-col justify-between gap-5 p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
          <Icon
            className={cn("size-4", updating && "animate-spin motion-reduce:animate-none")}
            aria-hidden
          />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold">
            {retry ? "Machine update needs attention" : updating ? "Updating machines" : "Machine update available"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          {eligibleMachines.length > 0 && (
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {eligibleMachines.map((machine) => machine.displayName || machine.hostname).join(", ")}
            </p>
          )}
        </div>
      </div>
      {(!updating || retry || availableCount > 0) && (
        <Button
          type="button"
          data-testid={tid.daemonUpdateAction}
          className="h-11 self-end px-3 sm:h-9 sm:px-2"
          onClick={onRequestUpdate}
        >
          {retry ? "Retry" : "Update"}
        </Button>
      )}
    </div>
  )
}
