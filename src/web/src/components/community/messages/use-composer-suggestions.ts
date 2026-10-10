import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Editor } from "@tiptap/react"
import { exitSuggestion } from "@tiptap/suggestion"
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
  editorRef: { current: Editor | null }
  canSuggest: (editor: Editor) => boolean
  scope: string
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
  editorRef,
  canSuggest,
  scope,
  members,
  context,
  mentionCandidates,
  channelRefCandidates,
  channelRefCandidateSource,
  onChannelRefIntent,
}: ComposerSuggestionsOptions) {
  const [mentionPopup, setMentionPopup] = useAtom(useCreateAtom<MentionPopupState>(EMPTY_MENTION_STATE))
  const mentionPopupRef = useRef(mentionPopup)
  const mentionQueryRef = useRef("")
  const canSuggestRef = useRef(canSuggest)
  useLayoutEffect(() => { canSuggestRef.current = canSuggest }, [canSuggest])
  const eligible = useCallback((editor: Editor) => canSuggestRef.current(editor), [])
  const isOpenEditor = useCallback(() => {
    const editor = editorRef.current
    return Boolean(editor && eligible(editor))
  }, [editorRef, eligible])
  const publishMention = useCallback((next: MentionPopupState | ((current: MentionPopupState) => MentionPopupState)) => {
    const resolved = typeof next === "function" ? next(mentionPopupRef.current) : next
    mentionPopupRef.current = resolved
    mentionQueryRef.current = resolved.query
    setMentionPopup(resolved)
  }, [setMentionPopup])

  const [channelRefPopupState, setChannelRefPopup] =
    useAtom(useCreateAtom<ChannelRefPopupState>(EMPTY_CHANNEL_REF_STATE))
  const channelRefPopup = useMemo(() => {
    if (!channelRefPopupState.command) return channelRefPopupState
    const items = rankChannelRefItems(channelRefCandidates, channelRefPopupState.query ?? "")
    if (channelRefItemsEqual(channelRefPopupState.items, items)) return channelRefPopupState
    return {
      ...channelRefPopupState,
      items,
      selectedIndex: channelRefPopupState.selectedIndex < items.length
        ? channelRefPopupState.selectedIndex
        : 0,
    }
  }, [channelRefCandidates, channelRefPopupState])
  const channelRefPopupRef = useRef(channelRefPopup)
  const channelRefQueryRef = useRef("")
  const publishChannelRef = useCallback((next: ChannelRefPopupState | ((current: ChannelRefPopupState) => ChannelRefPopupState)) => {
    const resolved = typeof next === "function" ? next(channelRefPopupRef.current) : next
    channelRefPopupRef.current = resolved
    channelRefQueryRef.current = resolved.query ?? ""
    setChannelRefPopup(resolved)
  }, [setChannelRefPopup])
  useLayoutEffect(() => {
    if (!isOpenEditor() || channelRefPopup.command !== channelRefPopupRef.current.command) return
    if (channelRefPopup !== channelRefPopupState) publishChannelRef(channelRefPopup)
  }, [channelRefPopup, channelRefPopupState, isOpenEditor, publishChannelRef])

  const membersRef = useRef(members)
  const contextRef = useRef(context)
  const onSearchMembersRef = useRef(mentionCandidates?.search)
  useEffect(() => {
    membersRef.current = members
  }, [members])

  // eslint-disable-next-line react-hooks/refs -- runtime suggestion callbacks read these refs
  const [mentionExtension] = useState(() =>
    buildCommunityMentionExtension({
      editorRef,
      canSuggest: eligible,
      membersRef,
      contextRef,
      popupRef: mentionPopupRef,
      setPopup: publishMention,
      onSearchMembersRef,
      queryRef: mentionQueryRef,
    }),
  )

  const channelRefCandidatesRef = useRef(channelRefCandidates)
  const onChannelRefIntentRef = useRef(onChannelRefIntent)
  useEffect(() => {
    channelRefCandidatesRef.current = channelRefCandidates
  }, [channelRefCandidates])

  const channelRefPresentation: ChannelRefCandidatePresentation | undefined =
    channelRefCandidateSource
      ? {
          status: channelRefCandidateSource.failed
            ? "error"
            : channelRefCandidateSource.loading
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
      editorRef,
      canSuggest: eligible,
      candidatesRef: channelRefCandidatesRef,
      popupRef: channelRefPopupRef,
      onIntentRef: onChannelRefIntentRef,
      setPopup: publishChannelRef,
      queryRef: channelRefQueryRef,
    }),
  )

  const resetPopups = useCallback((editor = editorRef.current, exit = true) => {
    if (editor && editorRef.current !== editor) return
    if (mentionQueryRef.current || mentionPopupRef.current.command) onSearchMembersRef.current?.("")
    publishMention(EMPTY_MENTION_STATE)
    publishChannelRef(EMPTY_CHANNEL_REF_STATE)
    if (!exit || !editor || editor.isDestroyed) return
    exitSuggestion(editor.view, mentionExtension.options.suggestion.pluginKey)
    exitSuggestion(editor.view, channelRefExtension.options.suggestion.pluginKey)
  }, [editorRef, mentionExtension, channelRefExtension, publishMention, publishChannelRef])
  useLayoutEffect(() => { resetPopups() }, [scope, resetPopups])
  useLayoutEffect(() => {
    contextRef.current = context
    onSearchMembersRef.current = mentionCandidates?.search
  }, [context, mentionCandidates?.search])

  useEffect(() => {
    if (context === "dm" || !isOpenEditor()) return
    const current = mentionPopupRef.current
    if (!current.command) return
    const query = mentionQueryRef.current
    const remoteSearchReady = !query || !mentionCandidates?.search || mentionCandidates.searchQuery === query
    const items = rankMentionItems(
      remoteSearchReady ? members : [],
      context,
      query,
    )
    if (mentionItemsEqual(current.items, items)) return
    publishMention({
      ...current,
      items,
      selectedIndex:
        current.selectedIndex < items.length ? current.selectedIndex : 0,
    })
  }, [context, members, mentionCandidates, isOpenEditor, publishMention])

  useEffect(() => {
    const current = mentionPopupRef.current
    if (!isOpenEditor()) return
    if (!current.command || current.query.trim()) return
    if (!mentionCandidates?.hasMore) return
    if (mentionCandidates.loading || mentionCandidates.loadingMore) return
    if (mentionCandidates.failed) return
    mentionCandidates.loadMore?.()
  }, [mentionCandidates, mentionPopup.command, mentionPopup.query, isOpenEditor])

  const mentionPresentation: MentionCandidatePresentation = (() => {
    if (!mentionCandidates) {
      return { status: mentionPopup.items.length > 0 ? "ready" : "empty" }
    }
    const query = mentionPopup.query
    if (query && mentionCandidates.search) {
      if (mentionCandidates.searchQuery !== query) return { status: "loading" }
    }
    const searchStatus = query && mentionCandidates.search ? mentionCandidates.searchStatus : undefined
    if (mentionCandidates.failed || searchStatus === "error") return { status: "error" }
    if (mentionCandidates.loading || searchStatus === "loading" || searchStatus === "idle") return { status: "loading" }
    if (mentionCandidates.loadingMore || mentionCandidates.hasMore || searchStatus === "loading-more") {
      return { status: "loading-more" }
    }
    return { status: mentionPopup.items.length > 0 ? "ready" : "empty" }
  })()

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
