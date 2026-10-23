"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { memo, useEffect, useRef } from "react";
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
import { RailServerIcon } from "./rail-server-icon"
import { RailFolderIcon } from "./rail-folder"
import { tid } from "@/lib/community/testids";
import type { Server } from "@/lib/community/models/navigation"
import type { RailOperation } from "@/lib/community/server-rail-model"
import { RailDndBinding, type RailDndController } from "./use-server-rail-dnd"

import { CommunityNavigationLink } from "./community-navigation-link"
import { serverRootHref } from "@/lib/community/community-route"

type SortableServerProps = {
  href?: string;
  navigationDisabled?: boolean;
  server: Server;
  active?: boolean;
  onClick: () => void;
  onLeave?: () => void;
  onOpenSettings?: () => void;
  onOpenInvitePopover?: () => void;
  inFolder?: boolean;
  dragging?: boolean;
  preview?: RailOperation | null;
  combineWith?: Server;
  dnd?: RailDndController;
  dragDescriptionId?: string;
};

function SortableServerImpl({
  server,
  href = serverRootHref(server.id),
  navigationDisabled,
  active,
  onClick,
  onLeave,
  onOpenSettings,
  onOpenInvitePopover,
  inFolder,
  dragging: isDragActive,
  preview,
  combineWith,
  dnd,
  dragDescriptionId,
}: SortableServerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [confirmLeave, setConfirmLeave] = useAtom(useCreateAtom(false));
  const [activated, setActivated] = useAtom(useCreateAtom(false));
  const [tooltipOpen, setTooltipOpen] = useAtom(useCreateAtom(false));
  useEffect(() => { if (isDragActive) setTooltipOpen(false) }, [isDragActive, setTooltipOpen])

  const activate = activated ? undefined : () => setActivated(true);

  const icon = (
    <div
      ref={rootRef}
      style={{ opacity: isDragActive ? 0.3 : 1 }}
      data-rail-preview={preview || undefined}
      className="group relative flex w-full justify-center"
      onPointerEnter={activate}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      onKeyDownCapture={activate}
      onContextMenuCapture={activate}
    >
      {dnd && <RailDndBinding dnd={dnd} entity={{ kind: "server", id: server.id }} element={rootRef} handle={linkRef} />}
      <RailIndicator
        active={active}
        unread={server.unread}
        testId={tid.serverRailIndicator(server.id)}
        hidden={isDragActive}
      />
      {preview && preview !== "combine" && <span data-slot="community-server-rail-insert" className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary ${preview === "reorder-before" ? "-top-1 -translate-y-1/2" : "-bottom-1 translate-y-1/2"}`} />}
      <div
        className={[
          "relative size-10 transition-[border-radius,background-color,border-color,opacity,transform] duration-150",
          preview === "combine" && !combineWith ? "rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-(--d-rail)" : "",
        ].join(" ")}
      >
        <CommunityNavigationLink
          href={href}
          active={active}
          navigationDisabled={navigationDisabled}
          draggable={false}
          ref={linkRef}
          data-testid={tid.serverIcon(server.id)}
          data-dragging={isDragActive || undefined}
          aria-label={server.official ? `${server.name}, Official server` : server.name}
          aria-describedby={dragDescriptionId}
          onActivate={() => { if (!active) onClick() }}
          className={[
            "group/server absolute left-1/2 top-1/2 z-1 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing [-webkit-touch-callout:none]",
            active ? "cursor-default" : "cursor-pointer",
          ].join(" ")}
        >
          {preview === "combine" && combineWith ? (
            <span data-slot="community-server-rail-combine-preview" className="pointer-events-none absolute -inset-0.5 grid size-12 place-items-center rounded-[12px] bg-accent/50 text-muted-foreground ring-2 ring-primary dark:bg-accent">
              <RailFolderIcon open={false} folderServers={[server, combineWith]} />
            </span>
          ) : <RailServerIcon server={server} active={active} />}
        </CommunityNavigationLink>
        {server.mentions > 0 && !(preview === "combine" && combineWith) && (
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

  const withMenu = (
    <ContextMenu>
      <ContextMenuTrigger render={icon} onTouchStart={(event) => { if (dnd?.latest.current.canStart()) event.preventBaseUIHandler() }} />
      {activated && (
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
      )}
    </ContextMenu>
  );

  return (
    <>
      <Tooltip open={!isDragActive && tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger
          render={<span className="flex w-full justify-center" />}
        >
          {withMenu}
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {server.name}
        </TooltipContent>
      </Tooltip>
      {confirmLeave && (
        <ConfirmDialog
          open
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
    a.official === b.official &&
    a.unread === b.unread &&
    a.mentions === b.mentions &&
    a.isOwner === b.isOwner &&
    prev.href === next.href &&
    prev.navigationDisabled === next.navigationDisabled &&
    prev.active === next.active &&
    prev.inFolder === next.inFolder &&
    prev.dragging === next.dragging &&
    prev.preview === next.preview &&
    prev.combineWith?.id === next.combineWith?.id &&
    prev.combineWith?.name === next.combineWith?.name &&
    prev.combineWith?.initial === next.combineWith?.initial &&
    prev.combineWith?.icon === next.combineWith?.icon &&
    // The presence of an optional handler flips menu items on/off, so compare
    // definedness (not identity) — a menu row appears/disappears with it.
    !!prev.onLeave === !!next.onLeave &&
    !!prev.onOpenSettings === !!next.onOpenSettings &&
    !!prev.onOpenInvitePopover === !!next.onOpenInvitePopover &&
    prev.dragDescriptionId === next.dragDescriptionId
  );
}

export const SortableServer = memo(SortableServerImpl, serverPropsEqual);
