"use client"

import { useEffect, useState } from "react"
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

export type ChannelSidebarRevealBoundaryProps = Omit<
  ChannelSidebarScopeProps,
  "categories"
> & {
  categories: Category[]
  primaryReady: boolean
  forumProjectionMissing: boolean
  trustedRestoredPrimary: boolean
}

/**
 * A trusted restored primary tree reveals even when it arrives asynchronously
 * and the non-persisted forum projection is still pending. A true-cold tree
 * reveals once, after its primary data and initial forum projection are both
 * ready. Later forum refetches never hide or remount the revealed tree.
 */
export function ChannelSidebarRevealBoundary({
  categories,
  primaryReady,
  forumProjectionMissing,
  trustedRestoredPrimary,
  ...scopeProps
}: ChannelSidebarRevealBoundaryProps) {
  const [revealed, setRevealed] = useState(primaryReady && trustedRestoredPrimary)

  useEffect(() => {
    if (primaryReady && (trustedRestoredPrimary || !forumProjectionMissing)) {
      setRevealed(true)
    }
  }, [forumProjectionMissing, primaryReady, trustedRestoredPrimary])

  return (
    <ChannelSidebarScope
      categories={primaryReady && revealed ? categories : null}
      {...scopeProps}
    />
  )
}

/**
 * Owns the only server-sidebar loading boundary. Once canonical or structural
 * categories exist, secondary fetches may reconcile the mounted tree but must
 * never replace cached rows with a skeleton.
 */
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
