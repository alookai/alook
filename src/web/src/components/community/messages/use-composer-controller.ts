import { useMutation, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections";
import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type DragEvent,
  type ForwardedRef,
} from "react"
import { useEditor, type Editor, type JSONContent } from "@tiptap/react"
import Placeholder from "@tiptap/extension-placeholder"
import { DOMParser as PMDOMParser } from "@tiptap/pm/model"
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_SIZE_BYTES } from "@alook/shared"
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
  createLongPasteAttachment,
  pendingFilesToSendAttachments,
} from "./composer-file-utils"
import { handleComposerEditorKeyDown } from "./composer-keydown"
import { composerDocumentExtensions, preserveComposerPlainTextPaste, serializeComposerDocument } from "./composer-ordered-list"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import { mentionNodesForCaretInsertion, textNodeForCaretInsertion } from "./caret-text-insertion"
import type { ComposerViewProps } from "./composer-view"
import { useComposerSuggestions } from "./use-composer-suggestions"

export function useComposerController(
  {
    channel,
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
  const registry = useOptionalCommunityDbRegistry()
  const client = useQueryClient()
  const draftKey = registry && requestedDraftKey ? `${registry.accountId}:${requestedDraftKey}` : undefined
  const isForumThreadBody = mode === "forumThreadBody"
  const hoverCapable = useHoverCapable()
  const hoverCapableRef = useRef(hoverCapable)
  const [editorHasContent, setEditorHasContent] = useAtom(useCreateAtom(false))
  const protocol = useCreateStore({ active: true, generation: 0, scope: "", scopeVersion: 0, draftKey, nextLongPasteIndex: 1, suppress: false, previousHasContent: false })
  const sendKey = ["community", "composer-accept", useCreateAtom(crypto.randomUUID()).get()]
  const sendInFlight = useIsMutating({ mutationKey: sendKey, exact: true }) > 0
  useLayoutEffect(() => {
    hoverCapableRef.current = hoverCapable
  }, [hoverCapable])
  const attachments = useFileAttachments({ maxFileSize: MAX_ATTACHMENT_SIZE_BYTES,
    maxFiles: MAX_ATTACHMENTS_PER_MESSAGE, thumbnailPolicy: "community",
    draftSessionScope: isForumThreadBody ? undefined : draftKey })
  const {
    pendingFiles,
    setPendingFiles,
    transferPendingFiles,
    awaitPendingFiles,
    addPendingFiles,
    fileInputRef,
    handleFileSelect,
    removePendingFile,
    dragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop: handleDropRaw,
  } = attachments
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
  const resolvedPlaceholder = placeholder ?? (context === "channel" ? `Message /${channel}` : `Message ${channel}`)
  const placeholderRef = useRef(resolvedPlaceholder)
  const resolvePlaceholder = useCallback(() => placeholderRef.current, [])
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
  const { resetPopups } = suggestions
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, draftKey, scope, ...(state.scope !== scope ? { scopeVersion: state.scopeVersion + 1, nextLongPasteIndex: 1 } : {}) }))
  }, [scope, draftKey, protocol])
  const fireTyping = () => {
    if (!onTyping || typingTimer.current) return
    onTyping()
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null
    }, 3_000)
  }
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...composerDocumentExtensions(isForumThreadBody),
      // eslint-disable-next-line react-hooks/refs
      Placeholder.configure({
        placeholder: resolvePlaceholder,
      }),
      suggestions.mentionExtension,
      suggestions.channelRefExtension,
    ],
    editorProps: {
      attributes: {
        class: "outline-none",
        enterkeyhint:
          isForumThreadBody || !hoverCapable ? "enter" : "send",
      },
      handleKeyDown: (view, event) =>
        handleComposerEditorKeyDown(view, event, {
          hoverCapable: hoverCapableRef.current,
          channelRefOpen:
            suggestions.channelRefPopupRef.current.items.length > 0 &&
            suggestions.channelRefPopupRef.current.command !== null,
          isForumThreadBody,
          mentionOpen:
            suggestions.mentionPopupRef.current.items.length > 0 &&
            suggestions.mentionPopupRef.current.command !== null,
          send: () => sendRef.current(),
          liftEmptyBlock: () => editorRef.current?.commands.liftEmptyBlock() ?? false,
          splitListItem: () => editorRef.current?.commands.splitListItem("listItem") ?? false,
          undoInputRule: () => editorRef.current?.commands.undoInputRule() ?? false,
        }),
      handlePaste: (view, event, slice) => {
        const files = clipboardFiles(event.clipboardData?.items)
        if (files.length > 0) {
          event.preventDefault()
          void addPendingFiles(files)
          return true
        }

        const clipboardText = event.clipboardData?.getData("text/plain")
        const attachment = createLongPasteAttachment(
          clipboardText,
          attachments.readPendingFiles().map(({ file }) => file.name),
          protocol.get().nextLongPasteIndex,
        )
        if (attachment) {
          event.preventDefault()
          protocol.setState((state) => ({ ...state, nextLongPasteIndex: attachment.nextIndex }))
          void addPendingFiles([attachment.file])
          return true
        }

        return preserveComposerPlainTextPaste(
          view,
          clipboardText,
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
    },
    onUpdate: ({ editor: updatedEditor }) => {
      setEditorHasContent(!updatedEditor.isEmpty)
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
    onBlur: ({ editor: blurredEditor }) => resetPopups(blurredEditor),
  })
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, active: true }))
    const onDestroy = () => {
      if (editorRef.current !== editor) return
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      resetPopups(editor, false)
    }
    editor?.on("destroy", onDestroy)
    return () => {
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      editor?.off("destroy", onDestroy)
      resetPopups(editor)
    }
  }, [editor, protocol, resetPopups])
  useLayoutEffect(() => {
    editorRef.current = editor
    return () => { if (editorRef.current === editor) editorRef.current = null }
  }, [editor])
  const enterKeyHint = isForumThreadBody || !hoverCapable ? "enter" : "send"
  useLayoutEffect(() => {
    editor?.view?.dom?.setAttribute("enterkeyhint", enterKeyHint)
  }, [editor, enterKeyHint])
  useLayoutEffect(() => {
    if (placeholderRef.current === resolvedPlaceholder) return
    placeholderRef.current = resolvedPlaceholder
    if (!editor) return
    editor.view?.dispatch(editor.state.tr)
  }, [editor, resolvedPlaceholder])
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
        setEditorHasContent(!editor.isEmpty)
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

  const sendCommand = useMutation({ meta: { observabilityAction: "message.compose.send" }, mutationKey: sendKey, gcTime: 0,
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
      setEditorHasContent(false)
      if (protocol.get().draftKey) clearComposerDraft(protocol.get().draftKey!)
      transferPendingFiles()
      protocol.setState((state) => ({ ...state, nextLongPasteIndex: 1 }))
      resetPopups()
    },
  })
  const send = () => {
    if (!editor || client.isMutating({ mutationKey: sendKey, exact: true })) return
    const current = protocol.get()
    if (!current.active) return
    sendCommand.mutate({ generation: current.generation, scopeVersion: current.scopeVersion, editor })
  }

  useLayoutEffect(() => {
    sendRef.current = send
  })

  useImperativeHandle(ref, () => ({
    focusEditor: () => {
      suppressSuggestions(() => editor?.commands.focus("end"))
    },
    insertTextAtCaret: (text) => {
      if (!editor || !text) return
      const insertion = textNodeForCaretInsertion(text, editor.state)
      editor.chain().focus().insertContent(insertion).run()
    },
    insertMentionAtCaret: (mention) => {
      if (editor && mention.id && mention.label) editor.chain().focus().insertContent(mentionNodesForCaretInsertion(mention, editor.state)).run()
    },
    submitNow: () => {
      send()
    },
    resetAfterSubmit: () => {
      if (!editor) return
      editor.commands.clearContent()
      setEditorHasContent(false)
      setPendingFiles([])
      protocol.setState((state) => ({ ...state, nextLongPasteIndex: 1 }))
      resetPopups()
    },
    isEmpty: () => !editor || (editor.isEmpty && pendingFiles.length === 0),
    openFilePicker: () => {
      fileInputRef.current?.click()
    },
  }))

  useEffect(() => {
    if (!autoFocus || !editor || isForumThreadBody || editor.isFocused) return
    if (document.activeElement?.closest(`[data-testid="${tid.serverRailScroll}"]`)) return
    suppressSuggestions(() => editor.commands.focus("end"))
  }, [autoFocus, editor, channel, isForumThreadBody, suppressSuggestions])

  const previousReplyingToRef = useRef(replyingTo)
  useEffect(() => {
    const targetChanged = previousReplyingToRef.current !== replyingTo
    previousReplyingToRef.current = replyingTo
    if (targetChanged && replyingTo && editor && !isForumThreadBody) {
      suppressSuggestions(() => editor.commands.focus("end"))
    }
  }, [replyingTo, editor, isForumThreadBody, suppressSuggestions])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    handleDropRaw(event)
    suppressSuggestions(() => editor?.commands.focus())
  }

  return {
    isForumThreadBody,
    dragging,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    mentionPopup: suggestions.mentionPopup,
    mentionPresentation: suggestions.mentionPresentation,
    channelRefPopup: suggestions.channelRefPopup,
    channelRefPresentation: suggestions.channelRefPresentation,
    replyingTo,
    onCancelReply,
    pendingFiles,
    removePendingFile,
    fileInputRef,
    onFileSelect: handleFileSelect,
    editor,
    hideAttach,
    hideEmoji,
    showSend: !isForumThreadBody && !hoverCapable,
    sendDisabled:
      sendInFlight || (!editorHasContent && pendingFiles.length === 0),
    onSend: send,
    onUploadFile: () => {
      fileInputRef.current?.click()
    },
    onEmojiPick: (emoji) => {
      editor?.chain().focus().insertContent(emoji).run()
    },
  }
}
