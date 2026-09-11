"use client"

import type { Category } from "@/lib/community/models/navigation"
import {
  ChannelSidebar,
  ChannelSidebarSkeleton,
  type ChannelSidebarProps,
} from "./channel-sidebar"
import { useChannelTree } from "./use-channel-tree"

export type ChannelSidebarTreeOwnerProps = Omit<ChannelSidebarProps, "tree"> & {
  categories: Category[]
  scopeKey: string
}

export type ChannelSidebarScopeProps = Omit<ChannelSidebarTreeOwnerProps, "categories"> & {
  categories: Category[] | null
  targetServerId: string
}

/** Keeps the cold readiness gate outside the state-owning tree component. */
export function ChannelSidebarScope({
  categories,
  scopeKey,
  targetServerId,
  ...sidebarProps
}: ChannelSidebarScopeProps) {
  if (!categories) {
    return (
      <ChannelSidebarSkeleton
        noHeader={sidebarProps.noHeader}
        showInviteAction={Boolean(
          sidebarProps.serverId && sidebarProps.onInvitePopoverOpenChange,
        )}
        targetServerId={targetServerId}
      />
    )
  }

  return (
    <ChannelSidebarTreeOwner
      key={scopeKey}
      categories={categories}
      scopeKey={scopeKey}
      {...sidebarProps}
    />
  )
}

/** Owns all local Channel Tree state for exactly one explicit dataset scope. */
export function ChannelSidebarTreeOwner({
  categories,
  scopeKey,
  ...sidebarProps
}: ChannelSidebarTreeOwnerProps) {
  const tree = useChannelTree(categories)

  return (
    <div
      className="contents"
      data-community-channel-tree-scope={scopeKey}
    >
      <ChannelSidebar {...sidebarProps} tree={tree} />
    </div>
  )
}
