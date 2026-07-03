"use client"

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle"
import { RightPanelContent } from "./right-panel"
import type { RightPanel, Member, Role, Msg, Thread, OpenProfile } from "./_types"

// Sheet-based right panel for the community channel UI.
// Renders the channel's threads / pinned / members / search panel as a non-modal Sheet:
// page content stays interactive, the sheet floats on top with its own shadow and resize
// handle on desktop, full-width on mobile.
export function CommunityPanelSheet({
  open,
  onOpenChange,
  kind,
  members,
  membersLoading,
  membersLoadingMore,
  membersHasMore,
  onLoadMoreMembers,
  onSearchMembers,
  pinned,
  pinnedLoading,
  searchResults,
  searchQuery,
  threads,
  threadsLoading,
  onOpenThread,
  onOpenProfile,
  onSetRole,
  onKickMember,
  myRole,
  onJumpToMessage,
  onSearch,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  kind: Exclude<RightPanel, null>
  members: Member[]
  membersLoading?: boolean
  membersLoadingMore?: boolean
  membersHasMore?: boolean
  onLoadMoreMembers?: () => void
  onSearchMembers?: (q: string) => void
  pinned: Msg[]
  pinnedLoading?: boolean
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  threadsLoading?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKickMember?: (name: string) => void
  myRole?: Role
  onJumpToMessage?: (id: string) => void
  onSearch?: (query: string) => void
}) {
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: 380,
    minWidth: 280,
    maxWidthRatio: 0.6,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false} disablePointerDismissal>
      <SheetContent
        side="right"
        showOverlay={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border data-[side=right]:sm:overflow-hidden"
      >
        <SheetTitle className="sr-only">{panelTitle(kind)}</SheetTitle>
        <SheetResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        <RightPanelContent
          kind={kind}
          members={members}
          membersLoading={membersLoading}
          membersLoadingMore={membersLoadingMore}
          membersHasMore={membersHasMore}
          onLoadMoreMembers={onLoadMoreMembers}
          onSearchMembers={onSearchMembers}
          pinned={pinned}
          pinnedLoading={pinnedLoading}
          searchResults={searchResults}
          searchQuery={searchQuery}
          threads={threads}
          threadsLoading={threadsLoading}
          showSearchInput
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
          onSetRole={onSetRole}
          onKickMember={onKickMember}
          myRole={myRole}
          onJumpToMessage={onJumpToMessage}
          onSearch={onSearch}
        />
      </SheetContent>
    </Sheet>
  )
}

function panelTitle(kind: Exclude<RightPanel, null>): string {
  switch (kind) {
    case "members": return "Members"
    case "pinned": return "Pinned Messages"
    case "search": return "Search"
    case "threads": return "Threads"
  }
}
