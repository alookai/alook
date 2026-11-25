import { useConversationActivity } from "@/contexts/view-activity"
import { useMutation, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections";
import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ForwardedRef,
} from "react"
import { useEditor, type Editor, type JSONContent } from "@tiptap/react"
import { DOMParser as PMDOMParser } from "@tiptap/pm/model"
import { useFileAttachments } from "@/hooks/use-file-attachments"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { tid } from "@/lib/community/testids"
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "@/lib/community/composer-draft"
import { detectMentionType } from "@/lib/community/mention-extension"
import { buildPasteDom } from "@/lib/community/paste-plain-text"
import {
  clipboardFiles,
  createComposerAttachmentInputHandlers,
  createLongPasteAttachment,
  pendingFilesToSendAttachments,
} from "./composer-file-utils"
import { createComposerDomKeyDownGuard, handleComposerEditorKeyDown } from "./composer-keydown"
import { composerDocumentExtensions, preserveComposerPlainTextPaste, serializeComposerDocument } from "./composer-ordered-list"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import { mentionNodesForCaretInsertion, textNodeForCaretInsertion } from "./caret-text-insertion"
import type { ComposerViewProps } from "./composer-view"
import { useComposerSuggestions } from "./use-composer-suggestions"
import { useComposerReplyMention } from "./use-composer-reply-mention"
import { createComposerFilePickerKeyboard } from "./composer-file-picker-keyboard"

export function useComposerController(
  {
    channel,
    channelType,
    context,
    members,
    mentionCandidates,
    channelRefCandidates = [],
    channelRefCandidateSource,
    onChannelRefIntent,
    sendContract,
    onAcceptSend,
    onDeferredSubmit,
    onTyping,
    replyingTo,
    onCancelReply,
    autoFocus = false,
    mode = "chat",
    placeholder,
    hideEmoji = false,
    hideAttach = false,
    onDirty,
    draftKey: requestedDraftKey,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
): ComposerViewProps {
  const active = useConversationActivity()
  const registry = useOptionalCommunityDbRegistry()
  const client = useQueryClient()
  const draftKey = registry && requestedDraftKey ? `${registry.accountId}:${requestedDraftKey}` : undefined
  const isForumThreadBody = mode === "forumThreadBody"
  const isForumThreadBodyRef = useRef(isForumThreadBody)
  const hoverCapable = useHoverCapable()
  const hoverCapableRef = useRef(hoverCapable)
  const editorHasContentAtom = useCreateAtom(false)
  const [editorHasContent] = useAtom(editorHasContentAtom)
  const isComposingAtom = useCreateAtom(false)
  const [isComposing] = useAtom(isComposingAtom)
  const protocol = useCreateStore({ active, generation: 0, scope: "", scopeVersion: 0, draftKey, nextLongPasteIndex: 1, suppress: false, previousHasContent: false })
  const sendId = useCreateAtom(crypto.randomUUID()).get()
  const sendKey = useMemo(() => ["community", "composer-accept", sendId], [sendId])
  const sendInFlight = useIsMutating({ mutationKey: sendKey, exact: true }) > 0
  const enterKeyHint = isForumThreadBody || !hoverCapable ? "enter" : "send"
  const enterKeyHintRef = useRef(enterKeyHint)
  const resolvedPlaceholder = placeholder ?? (context === "channel" ? `Message /${channel}` : `Message ${channel}`)
  const placeholderRef = useRef(resolvedPlaceholder)
  useLayoutEffect(() => {
    hoverCapableRef.current = hoverCapable
    isForumThreadBodyRef.current = isForumThreadBody
    enterKeyHintRef.current = enterKeyHint
    placeholderRef.current = resolvedPlaceholder
  }, [enterKeyHint, hoverCapable, isForumThreadBody, resolvedPlaceholder])
  const attachments = useFileAttachments(isForumThreadBody ? undefined : draftKey)
  const {
    pendingFiles,
    clearPendingFiles,
    transferPendingFiles,
    awaitPendingFiles,
    addPendingFiles,
    readPendingFiles,
    fileInputRef,
    dragging,
  } = attachments
  const addPendingFilesRef = useRef(addPendingFiles)
  const readPendingFilesRef = useRef(readPendingFiles)
  useLayoutEffect(() => {
    addPendingFilesRef.current = addPendingFiles
    readPendingFilesRef.current = readPendingFiles
  }, [addPendingFiles, readPendingFiles])
  const typingTimer = useRef<NodeJS.Timeout | null>(null)
  const sendRef = useRef<() => void>(() => {})
  const editorRef = useRef<Editor | null>(null)
  const scope = `${context}\u0000${channel}\u0000${draftKey ?? ""}`
  const canSuggest = useCallback((candidate: Editor) => {
    const current = protocol.get()
    return candidate === editorRef.current && current.active && current.scope === scope &&
      !current.suppress && !candidate.isDestroyed && candidate.isFocused
  }, [protocol, scope])
  const suppressSuggestions = useCallback((operation: () => void) => {
    const previous = protocol.get().suppress
    protocol.setState((state) => ({ ...state, suppress: true }))
    try { operation() } finally { protocol.setState((state) => ({ ...state, suppress: previous })) }
  }, [protocol])
  const suggestions = useComposerSuggestions({
    editorRef,
    canSuggest,
    scope,
    members,
    context,
    mentionCandidates,
    channelRefCandidates,
    channelRefCandidateSource,
    onChannelRefIntent,
  })
  const { resetPopups, bindEditor } = suggestions
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, draftKey, scope, ...(state.scope !== scope ? { scopeVersion: state.scopeVersion + 1, nextLongPasteIndex: 1 } : {}) }))
  }, [scope, draftKey, protocol])
  const fireTyping = () => {
    if (!protocol.get().active || !onTyping || typingTimer.current) return
    onTyping()
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null
    }, 3_000)
  }
  const domKeyDownGuard = useMemo(() => createComposerDomKeyDownGuard(), [])
  const extensions = useMemo(
    () => [
      ...composerDocumentExtensions(isForumThreadBody),
      suggestions.mentionExtension,
      suggestions.channelRefExtension,
    ],
    [isForumThreadBody, suggestions.mentionExtension, suggestions.channelRefExtension],
  )
  const editorProps = useMemo<NonNullable<Parameters<typeof useEditor>[0]["editorProps"]>>(
    () => ({
      attributes: () => ({
        class: "outline-none",
        "aria-label": placeholderRef.current,
        enterkeyhint: enterKeyHintRef.current,
      }),
      handleKeyDown: (view, event) =>
        handleComposerEditorKeyDown(view, event, {
          hoverCapable: hoverCapableRef.current,
          channelRefOpen:
            suggestions.channelRefPopupRef.current.items.length > 0 &&
            suggestions.channelRefPopupRef.current.command !== null,
          isForumThreadBody: isForumThreadBodyRef.current,
          mentionOpen:
            suggestions.mentionPopupRef.current.items.length > 0 &&
            suggestions.mentionPopupRef.current.command !== null,
          send: () => sendRef.current(),
          liftEmptyBlock: () => editorRef.current?.commands.liftEmptyBlock() ?? false,
          splitListItem: () => editorRef.current?.commands.splitListItem("listItem") ?? false,
          undoInputRule: () => editorRef.current?.commands.undoInputRule() ?? false,
        }),
      handleDOMEvents: {
        compositionstart: () => {
          isComposingAtom.set(true)
          domKeyDownGuard.onCompositionStart()
          return false
        },
        compositionend: () => {
          isComposingAtom.set(false)
          if (editorRef.current) editorHasContentAtom.set(!editorRef.current.isEmpty)
          domKeyDownGuard.onCompositionEnd()
          return false
        },
        keydown: (view, event) => domKeyDownGuard.onKeyDown(view, event),
        paste: (_view, event) => {
          if (!protocol.get().active) { event.preventDefault(); return true }
          const files = clipboardFiles(event.clipboardData?.items)
          if (files.length > 0) {
            event.preventDefault()
            void addPendingFilesRef.current(files)
            return true
          }

          const clipboardText = event.clipboardData?.getData("text/plain")
          const attachment = createLongPasteAttachment(
            clipboardText,
            readPendingFilesRef.current().map(({ file }) => file.name),
            protocol.get().nextLongPasteIndex,
          )
          if (attachment) {
            event.preventDefault()
            protocol.setState((state) => ({ ...state, nextLongPasteIndex: attachment.nextIndex }))
            void addPendingFilesRef.current([attachment.file])
            return true
          }

          return false
        },
      },
      handlePaste: (view, event, slice) => {
        if (!protocol.get().active) { event.preventDefault(); return true }
        return preserveComposerPlainTextPaste(
          view,
          event.clipboardData?.getData("text/plain"),
          event.clipboardData?.getData("text/html"),
          slice,
        )
      },
      clipboardTextParser: (text, $context) => {
        const dom = buildPasteDom(text, document)
        return PMDOMParser.fromSchema($context.doc.type.schema).parseSlice(dom, {
          preserveWhitespace: true,
          context: $context,
        })
      },
    }),
    [
      domKeyDownGuard,
      editorHasContentAtom,
      isComposingAtom,
      protocol,
      suggestions.channelRefPopupRef,
      suggestions.mentionPopupRef,
    ],
  )
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    editorProps,
    onUpdate: ({ editor: updatedEditor }) => {
      editorHasContentAtom.set(!updatedEditor.isEmpty)
      if (protocol.get().suppress) return
      fireTyping()
      emitDirtyTransition()
      const key = protocol.get().draftKey
      if (key && !isForumThreadBody) {
        writeComposerDraft(
          key,
          updatedEditor.isEmpty ? null : updatedEditor.getJSON(),
        )
      }
    },
    onBlur: ({ editor: blurredEditor }) => {
      isComposingAtom.set(false)
      resetPopups(blurredEditor)
    },
  })
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, active }))
    editor?.setEditable(active, false)
    if (!active) { isComposingAtom.set(false); editor?.commands.blur(); resetPopups(editor) }
    const onDestroy = () => {
      if (editorRef.current !== editor) return
      isComposingAtom.set(false)
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      resetPopups(editor, false)
    }
    editor?.on("destroy", onDestroy)
    return () => {
      isComposingAtom.set(false)
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      editor?.off("destroy", onDestroy)
      resetPopups(editor)
    }
  }, [active, editor, isComposingAtom, protocol, resetPopups])
  useLayoutEffect(() => {
    editorRef.current = editor
    bindEditor?.(editor)
    return () => {
      if (editorRef.current === editor) editorRef.current = null
      bindEditor?.(null)
    }
  }, [bindEditor, editor])
  useLayoutEffect(() => {
    editor?.view?.dom?.setAttribute("aria-label", resolvedPlaceholder)
  }, [editor, resolvedPlaceholder])
  useLayoutEffect(() => {
    editor?.view?.dom?.setAttribute("enterkeyhint", enterKeyHint)
  }, [editor, enterKeyHint])
  useEffect(() => {
    if (!editor || isForumThreadBody || !draftKey) return
    const doc = readComposerDraft(draftKey)
    if (!doc) return
    resetPopups(editor)
    suppressSuggestions(() => {
      try {
        editor.commands.setContent(doc as JSONContent, {
          emitUpdate: false,
          errorOnInvalidContent: true,
        })
        editorHasContentAtom.set(!editor.isEmpty)
      } catch {
        clearComposerDraft(draftKey)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftKey])
  const onDirtyRef = useRef(onDirty)
  useEffect(() => {
    onDirtyRef.current = onDirty
  }, [onDirty])
  const emitDirtyTransition = () => {
    if (!editor) return
    const next = !editor.isEmpty || pendingFiles.length > 0
    if (next === protocol.get().previousHasContent) return
    protocol.setState((state) => ({ ...state, previousHasContent: next }))
    onDirtyRef.current?.(next)
  }
  useEffect(() => {
    emitDirtyTransition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles, editor])

  const sendCommand = useMutation({ mutationKey: sendKey, gcTime: 0,
    mutationFn: async ({ generation, scopeVersion, editor }: { generation: number; scopeVersion: number; editor: Editor }) => {
      const assert = () => { const current = protocol.get(); if (!current.active || current.generation !== generation || current.scopeVersion !== scopeVersion) throw new DOMException("Retired composer send", "AbortError") }
      assert()
      const preparedFiles = await awaitPendingFiles()
      assert()
      if (editor.isEmpty && preparedFiles.length === 0) return
      const markdown = editor.isEmpty ? "" : serializeComposerDocument(editor).trim()
      const mentionType = detectMentionType(markdown), payload = pendingFilesToSendAttachments([...preparedFiles])
      if (sendContract === "accepted") { if (!onAcceptSend?.(markdown, payload, mentionType)) return }
      else await onDeferredSubmit?.(markdown, payload, mentionType)
      assert()
      if (isForumThreadBody) return
      const accepted = sendContract === "accepted"
      if (accepted && typingTimer.current) clearTimeout(typingTimer.current)
      if (accepted) typingTimer.current = null
      protocol.setState((state) => ({ ...state, suppress: accepted }))
      try { editor.commands.clearContent() } finally { protocol.setState((state) => ({ ...state, suppress: false })) }
      isComposingAtom.set(false)
      editorHasContentAtom.set(false)
      if (protocol.get().draftKey) clearComposerDraft(protocol.get().draftKey!)
      transferPendingFiles()
      protocol.setState((state) => ({ ...state, nextLongPasteIndex: 1 }))
      resetPopups()
    },
  })
  const pickerKeyboard = useMemo(() => createComposerFilePickerKeyboard(editor,
    () => protocol.get().active && protocol.get().scope === scope,
    () => suppressSuggestions(() => { editor?.view.dom.blur(); editor?.view.focus() }),
    () => { const current = protocol.get(); return `${current.generation}:${current.scopeVersion}` },
  ), [editor, protocol, scope, suppressSuggestions])
  useLayoutEffect(() => () => pickerKeyboard.retire(), [active, pickerKeyboard])

  const send = useCallback(() => {
    pickerKeyboard.retire()
    if (!editor || client.isMutating({ mutationKey: sendKey, exact: true })) return
    const current = protocol.get()
    if (!current.active) return
    sendCommand.mutate({ generation: current.generation, scopeVersion: current.scopeVersion, editor })
  }, [client, editor, pickerKeyboard, protocol, sendCommand, sendKey])

  useLayoutEffect(() => {
    sendRef.current = send
  }, [send])

  const attachmentInputHandlers = createComposerAttachmentInputHandlers(
    () => protocol.get().active,
    attachments,
    () => suppressSuggestions(() => editor?.commands.focus()),
    pickerKeyboard.prepare,
  )

  useImperativeHandle(ref, () => ({
    focusEditor: () => {
      if (!protocol.get().active) return
      suppressSuggestions(() => editor?.commands.focus("end"))
    },
    insertTextAtCaret: (text) => {
      if (!protocol.get().active || !editor || !text) return
      const insertion = textNodeForCaretInsertion(text, editor.state)
      editor.chain().focus().insertContent(insertion).run()
    },
    insertMentionAtCaret: (mention) => {
      if (protocol.get().active && editor && mention.id && mention.label) editor.chain().focus().insertContent(mentionNodesForCaretInsertion(mention, editor.state)).run()
    },
    submitNow: () => {
      send()
    },
    resetAfterSubmit: () => {
      if (!protocol.get().active || !editor) return
      pickerKeyboard.retire()
      editor.commands.clearContent()
      isComposingAtom.set(false)
      editorHasContentAtom.set(false)
      clearPendingFiles()
      protocol.setState((state) => ({ ...state, nextLongPasteIndex: 1 }))
      resetPopups()
    },
    isEmpty: () => !editor || (editor.isEmpty && pendingFiles.length === 0),
    openFilePicker: () => {
      if (!protocol.get().active) return
      fileInputRef.current?.click()
    },
  }))

  useEffect(() => {
    if (!active || !autoFocus || !editor || isForumThreadBody || editor.isFocused) return
    if (document.activeElement?.closest(`[data-testid="${tid.serverRailScroll}"]`)) return
    suppressSuggestions(() => editor.commands.focus("end"))
  }, [active, autoFocus, editor, channel, isForumThreadBody, suppressSuggestions])

  useComposerReplyMention({ editor, channelType, isForumThreadBody, replyingTo, members, suppressSuggestions })

  return {
    ...attachmentInputHandlers,
    isForumThreadBody,
    dragging: active && dragging,
    mentionPopup: suggestions.mentionPopup,
    mentionPresentation: suggestions.mentionPresentation,
    mentionPagination: suggestions.mentionPagination,
    channelRefPopup: suggestions.channelRefPopup,
    channelRefPresentation: suggestions.channelRefPresentation,
    replyingTo,
    onCancelReply: onCancelReply ? () => { if (protocol.get().active) onCancelReply() } : undefined,
    pendingFiles,
    fileInputRef,
    editor,
    placeholder: resolvedPlaceholder,
    showPlaceholder: !editorHasContent && !isComposing,
    hideAttach,
    hideEmoji,
    showSend: !isForumThreadBody && !hoverCapable,
    sendDisabled:
      !active || sendInFlight || pendingFiles.some((file) => file.preparationFailed) || (!editorHasContent && pendingFiles.length === 0),
    onSend: send,
    onEmojiPick: (emoji) => {
      if (!protocol.get().active) return
      editor?.chain().focus().insertContent(emoji).run()
    },
  }
}
