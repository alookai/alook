"use client";

import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { RailIndicator } from "./rail-indicator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { NumberTicker } from "@/components/ui/number-ticker";
import { SeededBackdrop } from "@/components/avatar";
import { tid } from "@/lib/community/testids";
import type { Server } from "@/lib/community/models/navigation"
import type { RailEntity, RailOperation } from "@/lib/community/server-rail-model"

type SortableServerProps = {
  server: Server;
  active?: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  onLeave?: () => void;
  onOpenSettings?: () => void;
  onOpenInvitePopover?: () => void;
  inFolder?: boolean;
  dragging?: boolean;
  preview?: RailOperation | null;
  registerItem?: (
    entity: RailEntity,
    element: HTMLElement,
    dragHandle: HTMLElement,
  ) => () => void;
  dragDescriptionId?: string;
};

function SortableServerImpl({
  server,
  active,
  onClick,
  onPrefetch,
  onLeave,
  onOpenSettings,
  onOpenInvitePopover,
  inFolder,
  dragging: isDragActive,
  preview,
  registerItem,
  dragDescriptionId,
}: SortableServerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const restoreFocusAfterActivationRef = useRef(false)
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Lazy-mount the row's Base UI ContextMenu + ConfirmDialog. Eagerly mounting
  // them per rail icon (one Tooltip + ContextMenu + Dialog stack × N servers)
  // was the bulk of the switch re-render storm — the DialogPortal /
  // ContextMenuTrigger / FloatingTree ×1000s in perf:switch came from the rail,
  // not the message list (which already lazies its overlays; see message.tsx).
  // Activate on first hover OR focus OR keydown/contextmenu — focus/keydown are
  // required for a11y (keyboard context menu / Tab-to-icon have no pointerenter,
  // and a right-click is always preceded by a pointerenter so the menu is
  // mounted before it's invoked).
  const [activated, setActivated] = useState(false);
  useLayoutEffect(() => {
    if (!registerItem || !rootRef.current || !buttonRef.current) return
    return registerItem(
      { kind: "server", id: server.id },
      rootRef.current,
      buttonRef.current,
    )
  }, [activated, registerItem, server.id])
  useLayoutEffect(() => {
    if (!activated || !restoreFocusAfterActivationRef.current) return
    restoreFocusAfterActivationRef.current = false
    buttonRef.current?.focus()
  }, [activated])
  const activate = activated ? undefined : () => setActivated(true);
  const activateAndPrefetch = () => {
    activate?.();
    onPrefetch?.();
  };
  const activateFromFocus = () => {
    if (!activated) restoreFocusAfterActivationRef.current = true
    activateAndPrefetch()
  };

  const icon = (
    <div
      ref={rootRef}
      style={{ opacity: isDragActive ? 0.3 : 1 }}
      className="group relative flex w-full justify-center"
      onPointerEnter={activateAndPrefetch}
      onFocusCapture={activateFromFocus}
      onKeyDownCapture={activate}
    >
      {(preview === "reorder-before" || preview === "reorder-after") && (
        <div
          data-testid={tid.serverRailInsert(server.id)}
          className={`pointer-events-none absolute left-1/2 z-10 h-0.5 w-9 -translate-x-1/2 rounded-full bg-primary ${preview === "reorder-before" ? "-top-1" : "-bottom-1"}`}
        />
      )}
      <RailIndicator
        active={active}
        unread={server.unread}
        testId={tid.serverRailIndicator(server.id)}
      />
      <div
        className={[
          "relative size-10 transition-[border-radius,background-color,border-color,opacity,transform] duration-150",
          preview === "combine" ? "rounded-xl bg-primary/10 outline outline-2! outline-primary" : "",
          isDragActive ? "rounded-xl border-2 border-dashed border-muted-foreground/40" : "",
        ].join(" ")}
      >
        <button
          ref={buttonRef}
          data-testid={tid.serverIcon(server.id)}
          data-dragging={isDragActive || undefined}
          data-rail-preview={preview ?? undefined}
          aria-label={server.name}
          aria-describedby={dragDescriptionId}
          aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape"
          onClick={active ? undefined : onClick}
          className={[
            "group/server absolute left-1/2 top-1/2 z-1 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing [-webkit-touch-callout:none]",
            active ? "cursor-default" : "cursor-pointer",
          ].join(" ")}
        >
          <span data-rail-drag-preview className={[
            "pointer-events-none relative grid size-10 place-items-center overflow-hidden font-brand text-xl font-bold transition-all duration-150",
            active
              ? "cursor-default rounded-xl"
              : "cursor-pointer rounded-[18px] group-hover/server:rounded-xl",
            server.icon
              ? active
                ? "bg-primary text-primary-foreground"
                : "bg-card group-hover/server:bg-primary group-hover/server:text-primary-foreground"
              : "text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)] group-hover/server:brightness-110",
          ].join(" ")}
          >
            {server.icon ? (
              <img
                src={server.icon}
                alt={server.name}
                className="size-full object-cover"
              />
            ) : (
              <>
                <SeededBackdrop seed={server.id} />
                <span className="relative -translate-x-0.5 [-webkit-text-stroke:0.5px_currentColor]">
                  {server.initial}
                </span>
              </>
            )}
          </span>
        </button>
        {server.mentions > 0 && (
          <span
            data-testid={tid.railUnreadBadge(server.id)}
            className="pointer-events-none absolute -bottom-1 -right-1 z-2 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground ring-2 ring-(--d-rail)"
          >
            <NumberTicker value={server.mentions} />
          </span>
        )}
      </div>
    </div>
  );

  // Until activated, the icon carries no ContextMenu root — just the Tooltip.
  const withMenu = !activated ? (
    icon
  ) : (
    <ContextMenu>
      <ContextMenuTrigger render={icon} />
      <ContextMenuContent className="w-52">
        <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">
          {server.name}
        </div>
        {onOpenInvitePopover && (
          <ContextMenuItem onClick={onOpenInvitePopover}>
            Invite to Server
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={onOpenSettings} data-testid={tid.serverSettingsOpen}>
          Server settings
        </ContextMenuItem>
        {!server.isOwner && !inFolder && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => setConfirmLeave(true)}
              className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
            >
              Leave server
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex w-full justify-center" />}
        >
          {withMenu}
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {server.name}
        </TooltipContent>
      </Tooltip>
      {/* ConfirmDialog only mounts once the menu has been activated AND the
          user chose Leave — never eagerly per rail icon. */}
      {activated && (
        <ConfirmDialog
          open={confirmLeave}
          onOpenChange={setConfirmLeave}
          title={`Leave ${server.name}?`}
          description="You won't see this server's channels anymore, and you'll need a new invite to come back."
          confirmLabel="Leave server"
          confirmVariant="destructive"
          onConfirm={() => {
            setConfirmLeave(false);
            onLeave?.();
          }}
        />
      )}
    </>
  );
}

// Custom comparator — REQUIRED. The rail rebuilds `railServers` (a fresh
// `{ ...s, active }` per server) on every presence/roster/mention tick, and
// each rail item passes fresh per-render arrow callbacks, so a default shallow
// memo would always see "new" and never bail out. We compare the `server`
// fields that actually change plus the derived layout props, and DELIBERATELY
// ignore the callbacks: navigation callbacks close over a stable id + handler,
// while structural callbacks read current state and pending status from refs.
// Their identity churn therefore carries no new behavior. Without this, the
// whole rail (N servers × their Tooltip/Avatar)
// re-renders on every tick — the SortableServer/TooltipTrigger ×N in
// perf:switch after the lazy-overlay pass.
export function serverPropsEqual(prev: SortableServerProps, next: SortableServerProps): boolean {
  const a = prev.server;
  const b = next.server;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.initial === b.initial &&
    a.icon === b.icon &&
    a.unread === b.unread &&
    a.mentions === b.mentions &&
    a.isOwner === b.isOwner &&
    prev.active === next.active &&
    prev.inFolder === next.inFolder &&
    prev.dragging === next.dragging &&
    prev.preview === next.preview &&
    // The presence of an optional handler flips menu items on/off, so compare
    // definedness (not identity) — a menu row appears/disappears with it.
    !!prev.onLeave === !!next.onLeave &&
    !!prev.onOpenSettings === !!next.onOpenSettings &&
    !!prev.onOpenInvitePopover === !!next.onOpenInvitePopover &&
    prev.dragDescriptionId === next.dragDescriptionId &&
    !!prev.onPrefetch === !!next.onPrefetch
  );
}

export const SortableServer = memo(SortableServerImpl, serverPropsEqual);
