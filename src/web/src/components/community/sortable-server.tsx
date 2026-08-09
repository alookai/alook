"use client";

import { memo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import type { Server } from "./_types";

type SortableServerProps = {
  server: Server;
  active?: boolean;
  onClick: () => void;
  onLeave?: () => void;
  onOpenSettings?: () => void;
  onOpenInvitePopover?: () => void;
  onCreateFolder?: () => void;
  groupTarget?: boolean;
  inFolder?: boolean;
  dragging?: boolean;
};

function SortableServerImpl({
  server,
  active,
  onClick,
  onLeave,
  onOpenSettings,
  onOpenInvitePopover,
  onCreateFolder,
  groupTarget,
  inFolder,
  dragging: isDragActive,
}: SortableServerProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    activeIndex,
    index,
  } = useSortable({ id: server.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragActive ? 0.3 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const showLine = isOver && !isDragging && !isDragActive;
  const lineSide: "top" | "bottom" =
    activeIndex !== -1 && activeIndex < index ? "bottom" : "top";
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
  const activate = activated ? undefined : () => setActivated(true);

  const icon = (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative flex w-full justify-center"
      onPointerEnter={activate}
      onFocusCapture={activate}
      onKeyDownCapture={activate}
    >
      {showLine && (
        <div
          className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`}
        />
      )}
      <RailIndicator active={active} />
      <div
        className={[
          "relative size-10 transition-all duration-150",
          groupTarget ? "scale-110 rounded-xl ring-2 ring-primary" : "",
          isDragging
            ? "rounded-xl border-2 border-dashed border-muted-foreground/40"
            : "",
        ].join(" ")}
      >
        <button
          data-testid={tid.serverIcon(server.id)}
          onClick={active ? undefined : onClick}
          {...attributes}
          {...listeners}
          className={[
            "relative grid size-10 touch-none place-items-center overflow-hidden font-brand text-xl font-bold transition-all duration-150 active:cursor-grabbing",
            active
              ? "cursor-default rounded-xl"
              : "cursor-pointer rounded-[18px] hover:rounded-xl",
            server.icon
              ? active
                ? "bg-primary text-primary-foreground"
                : "bg-card hover:bg-primary hover:text-primary-foreground"
              : "text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)] hover:brightness-110",
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
              <SeededBackdrop variant="icon" seed={server.id} />
              <span className="relative -translate-x-0.5 [-webkit-text-stroke:0.5px_currentColor]">
                {server.initial}
              </span>
            </>
          )}
        </button>
        {server.mentions > 0 && (
          <span
            data-testid={tid.railUnreadBadge(server.id)}
            className="pointer-events-none absolute -bottom-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground ring-2 ring-(--d-rail)"
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
        {!inFolder && onCreateFolder && (
          <ContextMenuItem onClick={onCreateFolder}>
            Create group
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={onOpenSettings}>
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
// ignore the callbacks: every one closes over only a stable id + a
// shell-frame `useCallback`'d handler, so their identity churn carries no new
// behavior. Without this, the whole rail (N servers × their Tooltip/Avatar)
// re-renders on every tick — the SortableServer/TooltipTrigger ×N in
// perf:switch after the lazy-overlay pass.
function serverPropsEqual(prev: SortableServerProps, next: SortableServerProps): boolean {
  const a = prev.server;
  const b = next.server;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.initial === b.initial &&
    a.icon === b.icon &&
    a.mentions === b.mentions &&
    a.isOwner === b.isOwner &&
    prev.active === next.active &&
    prev.groupTarget === next.groupTarget &&
    prev.inFolder === next.inFolder &&
    prev.dragging === next.dragging &&
    // The presence of an optional handler flips menu items on/off, so compare
    // definedness (not identity) — a menu row appears/disappears with it.
    !!prev.onLeave === !!next.onLeave &&
    !!prev.onOpenSettings === !!next.onOpenSettings &&
    !!prev.onOpenInvitePopover === !!next.onOpenInvitePopover &&
    !!prev.onCreateFolder === !!next.onCreateFolder
  );
}

export const SortableServer = memo(SortableServerImpl, serverPropsEqual);
