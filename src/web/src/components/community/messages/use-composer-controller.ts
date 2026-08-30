import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ForwardedRef,
} from "react"
import { useEditor, type Editor, type JSONContent } from "@tiptap/react"
import Placeholder from "@tiptap/extension-placeholder"
import { DOMParser as PMDOMParser } from "@tiptap/pm/model"
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_SIZE_BYTES } from "@alook/shared"
import { useFileAttachments } from "@/hooks/use-file-attachments"
import { useHoverCapable } from "@/hooks/use-hover-capable"
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
    draftKey,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
): ComposerViewProps {
  const isForumThreadBody = mode === "forumThreadBody"
  const hoverCapable = useHoverCapable()
  const hoverCapableRef = useRef(hoverCapable)
  const [editorHasContent, setEditorHasContent] = useState(false)
  const [sendInFlight, setSendInFlight] = useState(false)
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
  const pendingFilesRef = useRef(pendingFiles)
  const nextLongPasteIndexRef = useRef(1)
  useLayoutEffect(() => {
    pendingFilesRef.current = pendingFiles
  }, [pendingFiles])
  const typingTimer = useRef<NodeJS.Timeout | null>(null)
  const sendRef = useRef<() => void>(() => {})
  const editorRef = useRef<Editor | null>(null)
  const sendInFlightRef = useRef<Promise<void> | null>(null)
  const lifecycleVersionRef = useRef(0)
  const draftKeyRef = useRef(draftKey)
  const sendScopeRef = useRef<string | null>(null)
  const sendScopeVersionRef = useRef(0)
  useLayoutEffect(() => {
    const nextScope = `${context}\u0000${channel}\u0000${draftKey ?? ""}`
    if (sendScopeRef.current !== nextScope) {
      sendScopeRef.current = nextScope
      sendScopeVersionRef.current++
      nextLongPasteIndexRef.current = 1
    }
    draftKeyRef.current = draftKey
  }, [channel, context, draftKey])
  useLayoutEffect(
    () => () => {
      lifecycleVersionRef.current++
    },
    [],
  )
  const restoringDraftRef = useRef(false)
  const resolvedPlaceholder =
    placeholder ??
    (context === "channel" ? `Message /${channel}` : `Message ${channel}`)
  const placeholderRef = useRef(resolvedPlaceholder)
  const resolvePlaceholder = useCallback(() => placeholderRef.current, [])
  const suggestions = useComposerSuggestions({
    members,
    context,
    mentionCandidates,
    channelRefCandidates,
    channelRefCandidateSource,
    onChannelRefIntent,
  })
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
          pendingFilesRef.current.map(({ file }) => file.name),
          nextLongPasteIndexRef.current,
        )
        if (attachment) {
          event.preventDefault()
          nextLongPasteIndexRef.current = attachment.nextIndex
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
      if (restoringDraftRef.current) return
      fireTyping()
      emitDirtyTransition()
      const key = draftKeyRef.current
      if (key && !isForumThreadBody) {
        writeComposerDraft(
          key,
          updatedEditor.isEmpty ? null : updatedEditor.getJSON(),
        )
      }
    },
  })
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
    restoringDraftRef.current = true
    try {
      editor.commands.setContent(doc as JSONContent, {
        emitUpdate: false,
        errorOnInvalidContent: true,
      })
      setEditorHasContent(!editor.isEmpty)
    } catch {
      clearComposerDraft(draftKey)
    } finally {
      restoringDraftRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftKey])
  const previousHasContentRef = useRef(false)
  const onDirtyRef = useRef(onDirty)
  useEffect(() => {
    onDirtyRef.current = onDirty
  }, [onDirty])
  const emitDirtyTransition = () => {
    if (!editor) return
    const next = !editor.isEmpty || pendingFiles.length > 0
    if (next === previousHasContentRef.current) return
    previousHasContentRef.current = next
    onDirtyRef.current?.(next)
  }
  useEffect(() => {
    emitDirtyTransition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles, editor])

  const send = () => {
    if (!editor || sendInFlightRef.current) return
    const attemptScopeVersion = sendScopeVersionRef.current
    const attemptLifecycle = lifecycleVersionRef.current
    sendInFlightRef.current = Promise.resolve()
    setSendInFlight(true)
    const attempt = (async () => {
      const preparedFiles = await awaitPendingFiles()
      if (
        lifecycleVersionRef.current !== attemptLifecycle ||
        sendScopeVersionRef.current !== attemptScopeVersion
      ) return
      if (editor.isEmpty && preparedFiles.length === 0) return
      const markdown = editor.isEmpty
        ? ""
        : serializeComposerDocument(editor).trim()
      const mentionType = detectMentionType(markdown)
      const payload = pendingFilesToSendAttachments([...preparedFiles])
      if (sendContract === "accepted") {
        if (!onAcceptSend?.(markdown, payload, mentionType)) return
      } else {
        await onDeferredSubmit?.(markdown, payload, mentionType)
      }
      if (isForumThreadBody) return
      editor.commands.clearContent()
      setEditorHasContent(false)
      if (draftKeyRef.current) clearComposerDraft(draftKeyRef.current)
      transferPendingFiles()
      nextLongPasteIndexRef.current = 1
      suggestions.resetPopups()
    })()
    sendInFlightRef.current = attempt
    void attempt.then(
      () => {
        if (sendInFlightRef.current === attempt) {
          sendInFlightRef.current = null
          setSendInFlight(false)
        }
      },
      () => {
        if (sendInFlightRef.current === attempt) {
          sendInFlightRef.current = null
          setSendInFlight(false)
        }
      },
    )
  }

  useLayoutEffect(() => {
    sendRef.current = send
  })

  useImperativeHandle(ref, () => ({
    focusEditor: () => {
      editor?.commands.focus("end")
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
      nextLongPasteIndexRef.current = 1
      suggestions.resetPopups()
    },
    isEmpty: () => !editor || (editor.isEmpty && pendingFiles.length === 0),
    openFilePicker: () => {
      fileInputRef.current?.click()
    },
  }))

  useEffect(() => {
    if (!autoFocus || !editor || isForumThreadBody) return
    editor.commands.focus("end")
  }, [autoFocus, editor, channel, isForumThreadBody])

  const previousReplyingToRef = useRef(replyingTo)
  useEffect(() => {
    const targetChanged = previousReplyingToRef.current !== replyingTo
    previousReplyingToRef.current = replyingTo
    if (targetChanged && replyingTo && editor && !isForumThreadBody) {
      editor.commands.focus("end")
    }
  }, [replyingTo, editor, isForumThreadBody])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    handleDropRaw(event)
    editor?.commands.focus()
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
