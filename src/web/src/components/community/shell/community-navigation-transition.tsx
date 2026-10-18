"use client"

import { createContext, useContext, useDeferredValue, useState, ViewTransition, type ReactNode } from "react"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityNavigationTransitionTypes, COMMUNITY_NAV_BACK, COMMUNITY_NAV_FORWARD } from "@/lib/community/navigation-transition"

type Props = {
  mobile: boolean
  targetHref: string
  parentHref?: string | null
  transitionTypes?: string[]
  children: ReactNode
}

const CommunityPageTransitionContext = createContext<{
  targetKey: string
  animation: string
  onAutomaticSnapshot: () => void
} | null>(null)

export function CommunityNavigationPage({ list, children }: { list: boolean; children: ReactNode }) {
  const presentation = useContext(CommunityPageTransitionContext)
  const frame = <div className="community-navigation-page" data-community-page-target={presentation?.targetKey}
    data-community-page-animation={presentation?.animation} data-community-page-list={list || undefined}>
    <ViewTransition default="none" update="none">{children}</ViewTransition>
  </div>
  return presentation ? <ViewTransition default="none" update={presentation.animation}
    onUpdate={presentation.onAutomaticSnapshot}>
    {frame}
  </ViewTransition> : frame
}

export function CommunityNavigationTransition(props: Props) {
  const deferred = useDeferredValue(props)
  const nextTypes = props.transitionTypes ?? communityNavigationTransitionTypes(
    deferred.targetHref, props.targetHref, deferred.parentHref)
  const capture = nextTypes.includes(COMMUNITY_NAV_BACK) || nextTypes.includes(COMMUNITY_NAV_FORWARD)
  const deferPresentation = props.mobile && capture && (
    props.mobile !== deferred.mobile
    || normalizeCommunityHref(props.targetHref).leafKey !== normalizeCommunityHref(deferred.targetHref).leafKey
  )
  const presentation = deferPresentation ? deferred : props
  const targetKey = normalizeCommunityHref(presentation.targetHref).leafKey
  const [previous, setPrevious] = useState({ key: targetKey, href: presentation.targetHref,
    parentHref: presentation.parentHref, fromHref: presentation.targetHref, fromParentHref: presentation.parentHref,
    generation: 0, consumed: false })
  if (previous.key !== targetKey) {
    setPrevious({ key: targetKey, href: presentation.targetHref, parentHref: presentation.parentHref,
      fromHref: previous.href, fromParentHref: previous.parentHref,
      generation: previous.generation + 1, consumed: false })
  } else if (previous.parentHref !== presentation.parentHref) {
    setPrevious({ ...previous, parentHref: presentation.parentHref })
  }
  const transitionTypes = previous.consumed ? [] : presentation.transitionTypes ?? communityNavigationTransitionTypes(
    previous.fromHref, presentation.targetHref, previous.fromParentHref)
  const animation = presentation.mobile
    ? transitionTypes.includes(COMMUNITY_NAV_BACK) ? COMMUNITY_NAV_BACK
      : transitionTypes.includes(COMMUNITY_NAV_FORWARD) ? COMMUNITY_NAV_FORWARD : "none"
    : "none"
  return <CommunityPageTransitionContext value={{ targetKey, animation,
    onAutomaticSnapshot: () => {
      if (animation === "none") return
      setPrevious((current) => current.generation === previous.generation && !current.consumed
        ? { ...current, consumed: true } : current)
    } }}>
    <div className="fixed inset-0" data-community-navigation-target={targetKey}>
      <ViewTransition default="none" update="none">
        {presentation.children}
      </ViewTransition>
    </div>
  </CommunityPageTransitionContext>
}
