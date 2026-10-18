"use client"

import { createContext, useContext, useDeferredValue, useState, ViewTransition, type ReactNode, type ViewTransitionInstance } from "react"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { COMMUNITY_NAV_GESTURE } from "./use-mobile-back-transition"
import { communityNavigationTransitionTypes, COMMUNITY_NAV_BACK, COMMUNITY_NAV_FORWARD } from "@/lib/community/navigation-transition"

type Props = {
  mobile: boolean
  targetHref: string
  parentHref?: string | null
  transitionTypes?: string[]
  backPreview?: { id: number; href: string; committing: boolean } | null
  attachBackSnapshot?: (instance: ViewTransitionInstance, id: number) => void | (() => void)
  children: ReactNode
}

const CommunityPageTransitionContext = createContext<{
  targetKey: string
  animation: string
  backPreview: Props["backPreview"]
  attachBackSnapshot: Props["attachBackSnapshot"]
} | null>(null)

export function CommunityNavigationPage({ list, children }: { list: boolean; children: ReactNode }) {
  const presentation = useContext(CommunityPageTransitionContext)
  const frame = <div className="community-navigation-page" data-community-page-target={presentation?.targetKey}
    data-community-page-animation={presentation?.animation} data-community-page-list={list || undefined}>
    <ViewTransition default="none" update="none">{children}</ViewTransition>
  </div>
  return presentation ? <ViewTransition default="none" update={presentation.animation}
    onUpdate={(instance) => presentation.backPreview
      ? presentation.attachBackSnapshot?.(instance, presentation.backPreview.id) : undefined}>
    {frame}
  </ViewTransition> : frame
}

export function CommunityNavigationTransition(props: Props) {
  const deferred = useDeferredValue(props)
  const presentation = props.mobile ? deferred : props
  const targetKey = normalizeCommunityHref(presentation.targetHref).leafKey
  const previewing = Boolean(presentation.backPreview)
  const [previous, setPrevious] = useState({ key: targetKey, href: presentation.targetHref,
    parentHref: presentation.parentHref, fromHref: presentation.targetHref, fromParentHref: presentation.parentHref,
    previewing, fromPreview: false })
  if (previous.key !== targetKey) {
    setPrevious({ key: targetKey, href: presentation.targetHref, parentHref: presentation.parentHref,
      fromHref: previous.href, fromParentHref: previous.parentHref, previewing, fromPreview: previous.previewing })
  } else if (previous.parentHref !== presentation.parentHref || previous.previewing !== previewing) {
    setPrevious({ ...previous, parentHref: presentation.parentHref, previewing,
      fromPreview: previous.fromPreview || previous.previewing })
  }
  const transitionTypes = previous.fromPreview ? [] : presentation.transitionTypes ?? communityNavigationTransitionTypes(
    previous.fromHref, presentation.targetHref, previous.fromParentHref)
  const animation = presentation.mobile
    ? presentation.backPreview ? COMMUNITY_NAV_GESTURE
      : transitionTypes.includes(COMMUNITY_NAV_BACK) ? COMMUNITY_NAV_BACK
      : transitionTypes.includes(COMMUNITY_NAV_FORWARD) ? COMMUNITY_NAV_FORWARD : "none"
    : "none"
  return <CommunityPageTransitionContext value={{ targetKey, animation,
    backPreview: presentation.backPreview, attachBackSnapshot: presentation.attachBackSnapshot }}>
    <div className="fixed inset-0" data-community-navigation-target={targetKey} inert={Boolean(presentation.backPreview) || undefined}>
      <ViewTransition default="none" update="none">
        {presentation.children}
      </ViewTransition>
    </div>
  </CommunityPageTransitionContext>
}
