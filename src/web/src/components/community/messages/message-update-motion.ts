"use client"

import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from "react"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { Reaction } from "@/lib/community/models/message"

const duration = 150
const arrivalFrames = [{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }]
const updateFrames = [{ opacity: 0.65 }, { opacity: 1 }]

export const MessageUpdateMotionContext = createContext<number | null>(null)

function playMotion(element: Element | null | undefined, frames: Keyframe[]) {
  if (element?.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
  return element?.animate?.(frames, { duration, easing: "ease-out" })
}

type ArrivalSnapshot = {
  root: HTMLDivElement
  channel: string
  entry: object | null | undefined
  rendererRevision: number
  tailAttached: boolean
  greatestSequence: number
  pendingKeys: ReadonlySet<string>
}

export function useMessageArrivalMotion(
  items: readonly FlatItem[],
  scrollRef: RefObject<HTMLDivElement | null>,
  options: { active: boolean; channel: string; entry?: object | null; rendererRevision: number; tailAttached: boolean; viewerId?: string | null },
) {
  const { active, channel, entry, rendererRevision, tailAttached, viewerId } = options
  const previous = useRef<ArrivalSnapshot | null>(null)
  const running = useRef(new Set<Animation>())

  useLayoutEffect(() => {
    const animations = running.current
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [])

  useLayoutEffect(() => {
    const root = scrollRef.current
    const last = previous.current
    const sameView = last !== null && last.root === root && last.channel === channel && last.entry === entry && last.rendererRevision === rendererRevision
    if (!active || !sameView) {
      for (const animation of running.current) animation.cancel()
    }
    if (!active || !root) {
      previous.current = null
      return
    }

    const pendingKeys = new Set<string>()
    const arrivals = new Set<string>()
    let greatestSequence = sameView ? last.greatestSequence : 0
    for (const item of items) {
      if (item.kind !== "message") continue
      const sequence = item.m.seq ?? 0
      const pending = !sequence && !!viewerId && item.m.authorId === viewerId && !!item.m.clientNonce
      greatestSequence = Math.max(greatestSequence, sequence)
      if (pending) pendingKeys.add(item.key)
      if (sameView && last.tailAttached && tailAttached
        && (sequence > last.greatestSequence && !last.pendingKeys.has(item.key)
          || pending && !last.pendingKeys.has(item.key))) arrivals.add(item.key)
    }
    previous.current = { root, channel, entry, rendererRevision, tailAttached, greatestSequence, pendingKeys }
    if (arrivals.size === 0) return

    const animations = running.current
    for (const row of root.querySelectorAll<HTMLElement>("[data-message-row-key]")) {
      if (!arrivals.has(row.dataset.messageRowKey ?? "")) continue
      const visual = row.querySelector<HTMLElement>("[data-message-renderer]") ?? row.firstElementChild?.firstElementChild
      const animation = playMotion(visual, arrivalFrames)
      if (animation) {
        animations.add(animation)
        const remove = () => { animations.delete(animation) }
        void animation.finished.then(remove, remove)
      }
    }
  }, [active, channel, entry, items, rendererRevision, scrollRef, tailAttached, viewerId])
}

export function useMessageReactionMotion(reactions: readonly Reaction[] | undefined) {
  const revision = useContext(MessageUpdateMotionContext)
  const group = useRef<HTMLDivElement | null>(null)
  const previous = useRef<{ revision: number; reactions: readonly Reaction[] | undefined } | null>(null)

  useLayoutEffect(() => {
    const last = previous.current
    previous.current = revision === null ? null : { revision, reactions }
    if (!last || last.revision !== revision || !reactions?.length || !group.current) return

    const former = new Map(last.reactions?.map(reaction => [reaction.emoji, reaction]))
    const changed = new Set<string>()
    for (const reaction of reactions) {
      const before = former.get(reaction.emoji)
      if (before?.count !== reaction.count || before.me !== reaction.me) changed.add(reaction.emoji)
    }
    if (changed.size === 0) return

    const animations: Animation[] = []
    for (const chip of group.current.querySelectorAll<HTMLButtonElement>("[data-message-reaction]")) {
      if (!changed.has(chip.dataset.messageReaction ?? "")) continue
      const animation = playMotion(chip, updateFrames)
      if (animation) animations.push(animation)
    }
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [reactions, revision])

  return group
}
