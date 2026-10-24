"use client"

import { useObservedRegion } from "@/lib/observability/regions"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useEffect } from "react"
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
}

/**
 * Reveal the complete target tree once both primary and forum data are ready.
 * Later forum refetches must not hide or remount the revealed tree.
 */
export function ChannelSidebarRevealBoundary({
  categories,
  primaryReady,
  forumProjectionMissing,
  ...scopeProps
}: ChannelSidebarRevealBoundaryProps) {
  const ready = primaryReady && !forumProjectionMissing
  const [revealed, setRevealed] = useAtom(useCreateAtom(ready))

  useEffect(() => {
    if (ready) setRevealed(true)
  }, [ready, setRevealed])

  return (
    <ChannelSidebarScope
      categories={primaryReady && (revealed || ready) ? categories : null}
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
        showInviteAction={Boolean(sidebarProps.serverId)}
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
  useObservedRegion("sidebar", true, categories.length)

  return (
    <div
      className="contents"
      data-community-channel-tree-scope={scopeKey}
    >
      <ChannelSidebar {...sidebarProps} tree={tree} />
    </div>
  )
}
