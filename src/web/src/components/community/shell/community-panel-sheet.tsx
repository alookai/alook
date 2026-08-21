"use client"

import {
  CommunitySheet,
  CommunitySheetTitle,
} from "@/components/community/shell/community-sheet"
import { RightPanelContent } from "./right-panel"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { Member } from "@/lib/community/models/people"
import type { CommunityRole as Role } from "@alook/shared"
import type { Msg, Thread } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { MemberManageContext } from "@/components/community/members/member-management-types"

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
  onAddMember,
  manageContext,
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
  viewerUserId,
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
  onAddMember?: () => void
  manageContext?: MemberManageContext
  pinned: Msg[]
  pinnedLoading?: boolean
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  threadsLoading?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (memberId: string, role: Role) => void
  onKickMember?: (memberId: string) => Promise<unknown> | void
  myRole?: Role
  onJumpToMessage?: (seq: number) => void
  onSearch?: (query: string) => void
  viewerUserId?: string
}) {
  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      mode="sidecar"
      width="sm"
      resizable
    >
        <CommunitySheetTitle className="sr-only">{panelTitle(kind)}</CommunitySheetTitle>
        <RightPanelContent
          kind={kind}
          members={members}
          membersLoading={membersLoading}
          membersLoadingMore={membersLoadingMore}
          membersHasMore={membersHasMore}
          onLoadMoreMembers={onLoadMoreMembers}
          onSearchMembers={onSearchMembers}
          onAddMember={onAddMember}
          manageContext={manageContext}
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
          viewerUserId={viewerUserId}
        />
    </CommunitySheet>
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
