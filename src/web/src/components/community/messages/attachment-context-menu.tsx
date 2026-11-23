"use client"

import { useState, type ReactElement } from "react"
import { flushSync } from "react-dom"
import { FolderOpen } from "lucide-react"
import { Download } from "@/components/icons/lucide"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  isKeyboardContextMenu,
  isSecondaryContextPointer,
} from "@/components/ui/context-menu"

export function isAttachmentContextMenuTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-attachment-context-menu="true"]') !== null
}

export function AttachmentContextMenu({
  attachmentName,
  trigger,
  onOpen,
  onDownload,
  downloading,
  disabled,
}: {
  attachmentName: string
  trigger: ReactElement
  onOpen?: () => void
  onDownload: () => void
  downloading?: boolean
  disabled?: boolean
}) {
  const [touchInput, setTouchInput] = useState(false)
  const menuDisabled = disabled || touchInput

  return (
    <ContextMenu disabled={menuDisabled}>
      <ContextMenuTrigger
        render={trigger}
        data-attachment-context-menu={menuDisabled ? undefined : "true"}
        className="select-text"
        style={{ WebkitTouchCallout: "default" }}
        onPointerDownCapture={(event) => {
          if (event.pointerType) setTouchInput(event.pointerType !== "mouse")
        }}
        onTouchStart={(event) => {
          setTouchInput(true)
          event.preventBaseUIHandler()
        }}
        onContextMenu={(event) => {
          const input = event.nativeEvent
          const touch = "pointerType" in input && (input.pointerType === "touch" || input.pointerType === "pen")
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target) || touch || !isSecondaryContextPointer(input)) {
            event.preventBaseUIHandler()
          }
        }}
        onKeyDown={(event) => {
          if (!isKeyboardContextMenu(event.nativeEvent)) return
          if (disabled || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) {
            event.preventDefault()
            return
          }
          event.stopPropagation()
          // The shared trigger dispatches the keyboard context event immediately.
          if (touchInput) flushSync(() => setTouchInput(false))
        }}
      />
      {!menuDisabled && <ContextMenuContent aria-label={`Attachment actions for ${attachmentName}`}>
        <ContextMenuItem disabled={!onOpen} onClick={onOpen}>
          <FolderOpen aria-hidden className="size-4" />
          Open
        </ContextMenuItem>
        <ContextMenuItem disabled={downloading} onClick={onDownload}>
          <Download aria-hidden className="size-4" />
          Download
        </ContextMenuItem>
      </ContextMenuContent>}
    </ContextMenu>
  )
}
