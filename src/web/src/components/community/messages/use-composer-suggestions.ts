import { useEffect, useRef, useState } from "react"
import {
  buildCommunityMentionExtension,
  EMPTY_MENTION_STATE,
  rankMentionItems,
  type MentionCandidatePresentation,
  type MentionContext,
  type MentionItem,
  type MentionPopupState,
} from "@/lib/community/mention-extension"
import {
  buildCommunityChannelRefExtension,
  EMPTY_CHANNEL_REF_STATE,
  rankChannelRefItems,
  type ChannelRefCandidatePresentation,
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"
import type { Member } from "@/lib/community/models/people"
import type {
  ChannelRefCandidateSource,
  MentionCandidateSource,
} from "./composer-types"

type ComposerSuggestionsOptions = {
  members: Member[]
  context: MentionContext
  mentionCandidates?: MentionCandidateSource
  channelRefCandidates: ChannelRefCandidate[]
  channelRefCandidateSource?: ChannelRefCandidateSource
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
      a[index].serverId !== b[index].serverId ||
      a[index].serverName !== b[index].serverName ||
      a[index].serverDiscriminator !== b[index].serverDiscriminator
    ) return false
  }
  return true
}

export function useComposerSuggestions({
  members,
  context,
  mentionCandidates,
  channelRefCandidates,
  channelRefCandidateSource,
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
  const onSearchMembersRef = useRef(mentionCandidates?.search)
  const mentionQueryRef = useRef("")
  useEffect(() => {
    membersRef.current = members
  }, [members])
  useEffect(() => {
    contextRef.current = context
  }, [context])
  useEffect(() => {
    onSearchMembersRef.current = mentionCandidates?.search
  }, [mentionCandidates?.search])

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

  const channelRefItemsAligned = !channelRefCandidateSource
    || !channelRefPopup.command
    || channelRefItemsEqual(
      channelRefPopup.items,
      rankChannelRefItems(channelRefCandidates, channelRefPopup.query ?? ""),
    )
  const channelRefPresentation: ChannelRefCandidatePresentation | undefined =
    channelRefCandidateSource
      ? {
          status: channelRefCandidateSource.failed
            ? "error"
            : channelRefCandidateSource.loading || !channelRefItemsAligned
              ? "loading"
              : channelRefPopup.items.length > 0
                ? "ready"
                : "empty",
        }
      : undefined
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
    const query = mentionQueryRef.current
    const remoteSearchReady = !query || !mentionCandidates
      || (mentionCandidates.searchQuery === query
        && (mentionCandidates.searchStatus === "ready"
          || mentionCandidates.searchStatus === "loading-more"
          || mentionCandidates.searchStatus === "empty"))
    const items = rankMentionItems(
      remoteSearchReady ? members : [],
      context,
      query,
    )
    if (mentionItemsEqual(current.items, items)) return
    setMentionPopup({
      ...current,
      items,
      selectedIndex:
        current.selectedIndex < items.length ? current.selectedIndex : 0,
    })
  }, [
    context,
    members,
    mentionCandidates,
  ])

  useEffect(() => {
    const current = mentionPopupRef.current
    if (!current.command || current.query.trim()) return
    if (!mentionCandidates?.hasMore) return
    if (mentionCandidates.loading || mentionCandidates.loadingMore) return
    if (mentionCandidates.failed) return
    mentionCandidates.loadMore()
  }, [mentionCandidates, mentionPopup.command, mentionPopup.query])

  const mentionPresentation: MentionCandidatePresentation = (() => {
    if (!mentionCandidates) {
      return { status: mentionPopup.items.length > 0 ? "ready" : "empty" }
    }
    const query = mentionPopup.query
    if (query) {
      if (mentionCandidates.searchQuery !== query) return { status: "loading" }
      if (mentionCandidates.searchStatus === "loading"
        || mentionCandidates.searchStatus === "idle") {
        return { status: "loading" }
      }
      if (mentionCandidates.searchStatus === "error") return { status: "error" }
      if (mentionCandidates.searchStatus === "loading-more") {
        return { status: "loading-more" }
      }
      return {
        status: mentionPopup.items.length > 0 ? "ready" : "empty",
      }
    }
    if (mentionCandidates.failed) return { status: "error" }
    if (mentionCandidates.loading) return { status: "loading" }
    if (mentionCandidates.loadingMore || mentionCandidates.hasMore) {
      return { status: "loading-more" }
    }
    return { status: mentionPopup.items.length > 0 ? "ready" : "empty" }
  })()

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
    mentionCandidates?.search("")
    setMentionPopup(EMPTY_MENTION_STATE)
    setChannelRefPopup(EMPTY_CHANNEL_REF_STATE)
  }

  return {
    mentionPopup,
    mentionPresentation,
    mentionPopupRef,
    mentionExtension,
    channelRefPopup,
    channelRefPresentation,
    channelRefPopupRef,
    channelRefExtension,
    resetPopups,
  }
}
