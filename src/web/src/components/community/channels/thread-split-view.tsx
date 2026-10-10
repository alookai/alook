"use client"
/* Hallmark · modern-minimal · focused/utilitarian · inherited neutral palette
 * macrostructure: parallel-conversation-panel · pre-emit: P5 H5 E4 S5 R5 V4 · slop: pass
 */

import type { ReactNode } from "react"
import { useDefaultLayout } from "react-resizable-panels"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ConversationResolutionPendingFrame } from "./conversation-resolution-pending-frame"

export const THREAD_SPLIT_PANEL_MIN_WIDTH = 360
export const THREAD_SPLIT_PANEL_MAX_WIDTH = 800

const threadSplitLayoutStorage = {
  getItem: (key: string) => typeof window === "undefined" ? null : window.localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value)
  },
}

export function ThreadSplitView({
  split,
  parent,
  thread,
  conversationSubtype = "thread",
  resolvingParent = false,
}: {
  split: boolean
  parent: ReactNode
  thread: ReactNode
  conversationSubtype?: "unknown" | "text" | "forum" | "thread"
  resolvingParent?: boolean
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "community-thread-split-layout",
    onlySaveAfterUserInteractions: true,
    storage: threadSplitLayoutStorage,
  })
  const isThread = conversationSubtype === "thread"

  return (
    <main
      data-testid={isThread ? tid.threadSplit : undefined}
      data-layout={split ? resolvingParent ? "pending" : "split" : "full"}
      data-community-conversation-subtype={conversationSubtype === "unknown" ? undefined : conversationSubtype}
      className="relative flex min-h-0 min-w-0 flex-1"
    >
      <ResizablePanelGroup
        id="community-thread-split-layout"
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={split && !resolvingParent ? onLayoutChanged : undefined}
        disabled={!split || resolvingParent}
        aria-hidden={resolvingParent || undefined}
        inert={resolvingParent || undefined}
        className={cn("min-h-0 flex-1", resolvingParent && "invisible", !split && [
          "*:data-[layout-hidden=true]:flex-none!",
          "*:data-[layout-hidden=true]:w-0!",
          "*:data-[layout-hidden=true]:min-w-0!",
          "*:data-[layout-hidden=true]:max-w-0!",
          "*:data-[layout-hidden=true]:overflow-hidden!",
          "*:data-[layout-active=true]:flex-1!",
          "*:data-[layout-active=true]:min-w-0!",
          "*:data-[layout-active=true]:max-w-none!",
        ])}
      >
        <ResizablePanel
          id="parent"
          defaultSize="56%"
          minSize={320}
          disabled={!split || resolvingParent}
          data-layout-hidden={!split || undefined}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {split && <section
            data-testid={tid.threadSplitParent}
            aria-label="Parent conversation"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {parent}
          </section>}
        </ResizablePanel>
        {split && !resolvingParent && <ResizableHandle
          aria-label="Resize thread panel"
          className="bg-border/60"
        />}
        <ResizablePanel
          id="thread"
          defaultSize="44%"
          minSize={THREAD_SPLIT_PANEL_MIN_WIDTH}
          maxSize={THREAD_SPLIT_PANEL_MAX_WIDTH}
          disabled={!split || resolvingParent}
          data-layout-active={!split || undefined}
          className="flex min-h-0 min-w-0 flex-col bg-background"
        >
          <section
            data-testid={isThread ? tid.threadSplitPanel : undefined}
            aria-label={isThread ? split ? "Thread panel" : "Thread" : "Conversation"}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {thread}
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
      {resolvingParent && <div className="absolute inset-0 flex min-h-0 flex-col">
        <ConversationResolutionPendingFrame />
      </div>}
    </main>
  )
}
