import { useEffect, useRef, useState } from "react"
import {
  buildCommunityMentionExtension,
  EMPTY_MENTION_STATE,
  rankMentionItems,
  type MentionContext,
  type MentionItem,
  type MentionPopupState,
} from "@/lib/community/mention-extension"
import {
  buildCommunityChannelRefExtension,
  EMPTY_CHANNEL_REF_STATE,
  rankChannelRefItems,
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"
import type { Member } from "@/lib/community/models/people"

type ComposerSuggestionsOptions = {
  members: Member[]
  context: MentionContext
  onSearchMembers?: (query: string) => void
  channelRefCandidates: ChannelRefCandidate[]
  onChannelRefIntent?: () => void
}

function mentionItemsEqual(a: MentionItem[], b: MentionItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    const current = a[index]
    const next = b[index]
    if (
      current.kind !== next.kind ||
      current.id !== next.id ||
      current.label !== next.label
    ) return false
    if (current.kind === "member" && next.kind === "member") {
      if (
        current.avatar !== next.avatar ||
        current.status !== next.status
      ) return false
    }
  }
  return true
}

function channelRefItemsEqual(
  a: ChannelRefCandidate[],
  b: ChannelRefCandidate[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (
      a[index].id !== b[index].id ||
      a[index].name !== b[index].name ||
      a[index].serverId !== b[index].serverId
    ) return false
  }
  return true
}

export function useComposerSuggestions({
  members,
  context,
  onSearchMembers,
  channelRefCandidates,
  onChannelRefIntent,
}: ComposerSuggestionsOptions) {
  const [mentionPopup, setMentionPopup] = useState<MentionPopupState>(
    EMPTY_MENTION_STATE,
  )
  const mentionPopupRef = useRef(mentionPopup)
  useEffect(() => {
    mentionPopupRef.current = mentionPopup
  }, [mentionPopup])

  const [channelRefPopup, setChannelRefPopup] =
    useState<ChannelRefPopupState>(EMPTY_CHANNEL_REF_STATE)
  const channelRefPopupRef = useRef(channelRefPopup)
  useEffect(() => {
    channelRefPopupRef.current = channelRefPopup
  }, [channelRefPopup])

  const membersRef = useRef(members)
  const contextRef = useRef(context)
  const onSearchMembersRef = useRef(onSearchMembers)
  const mentionQueryRef = useRef("")
  useEffect(() => {
    membersRef.current = members
  }, [members])
  useEffect(() => {
    contextRef.current = context
  }, [context])
  useEffect(() => {
    onSearchMembersRef.current = onSearchMembers
  }, [onSearchMembers])

  // eslint-disable-next-line react-hooks/refs -- runtime suggestion callbacks read these refs
  const [mentionExtension] = useState(() =>
    buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef: mentionPopupRef,
      setPopup: setMentionPopup,
      onSearchMembersRef,
      queryRef: mentionQueryRef,
    }),
  )

  const channelRefCandidatesRef = useRef(channelRefCandidates)
  const onChannelRefIntentRef = useRef(onChannelRefIntent)
  const channelRefQueryRef = useRef("")
  useEffect(() => {
    channelRefCandidatesRef.current = channelRefCandidates
  }, [channelRefCandidates])
  useEffect(() => {
    onChannelRefIntentRef.current = onChannelRefIntent
  }, [onChannelRefIntent])

  // eslint-disable-next-line react-hooks/refs -- runtime suggestion callbacks read these refs
  const [channelRefExtension] = useState(() =>
    buildCommunityChannelRefExtension({
      candidatesRef: channelRefCandidatesRef,
      popupRef: channelRefPopupRef,
      onIntentRef: onChannelRefIntentRef,
      setPopup: setChannelRefPopup,
      queryRef: channelRefQueryRef,
    }),
  )

  useEffect(() => {
    const current = mentionPopupRef.current
    if (!current.command) return
    const items = rankMentionItems(members, context, mentionQueryRef.current)
    if (mentionItemsEqual(current.items, items)) return
    setMentionPopup({
      ...current,
      items,
      selectedIndex:
        current.selectedIndex < items.length ? current.selectedIndex : 0,
    })
  }, [members, context])

  useEffect(() => {
    const current = channelRefPopupRef.current
    if (!current.command) return
    const items = rankChannelRefItems(
      channelRefCandidates,
      channelRefQueryRef.current,
    )
    if (channelRefItemsEqual(current.items, items)) return
    setChannelRefPopup({
      ...current,
      items,
      selectedIndex:
        current.selectedIndex < items.length ? current.selectedIndex : 0,
    })
  }, [channelRefCandidates])

  const resetPopups = () => {
    setMentionPopup(EMPTY_MENTION_STATE)
    setChannelRefPopup(EMPTY_CHANNEL_REF_STATE)
  }

  return {
    mentionPopup,
    mentionPopupRef,
    mentionExtension,
    channelRefPopup,
    channelRefPopupRef,
    channelRefExtension,
    resetPopups,
  }
}
