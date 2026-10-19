"use client"
/* Hallmark · modern-minimal · focused/utilitarian · inherited neutral palette
 * macrostructure: parallel-conversation-panel · pre-emit: P5 H5 E4 S5 R5 V4 · slop: pass
 */

import { useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { useDefaultLayout, type GroupImperativeHandle, type Layout, type LayoutChangedMeta } from "react-resizable-panels"
import { useHydratedClient } from "@/components/community/shell/use-hydrated-client"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ConversationResolutionPendingFrame } from "./conversation-resolution-pending-frame"
import styles from "./thread-split-view.module.css"

const THREAD_SPLIT_PARENT_MIN_WIDTH = 320
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
  layoutPending = false,
  parent,
  thread,
  conversationSubtype = "thread",
  resolvingParent = false,
}: {
  split: boolean
  layoutPending?: boolean
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
  const hydratedClient = useHydratedClient()
  const groupRef = useRef<GroupImperativeHandle | null>(null)
  const hydratedLayoutAppliedRef = useRef(false)
  const restorePersistedLayout = useCallback(() => {
    if (!hydratedClient || !split || resolvingParent || hydratedLayoutAppliedRef.current
      || !defaultLayout || !groupRef.current) return
    if (Object.keys(groupRef.current.getLayout()).length === 0) return
    hydratedLayoutAppliedRef.current = true
    groupRef.current.setLayout(defaultLayout)
  }, [defaultLayout, hydratedClient, resolvingParent, split])
  useLayoutEffect(restorePersistedLayout, [restorePersistedLayout])
  const handleLayoutChanged = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    restorePersistedLayout()
    onLayoutChanged(layout, meta)
  }, [onLayoutChanged, restorePersistedLayout])
  const isThread = conversationSubtype === "thread"

  return (
    <main
      data-testid={isThread ? tid.threadSplit : undefined}
      data-layout={layoutPending || resolvingParent ? "pending" : split ? "split" : "full"}
      data-layout-pending={layoutPending || undefined}
      data-community-conversation-subtype={conversationSubtype === "unknown" ? undefined : conversationSubtype}
      className={cn("relative flex min-h-0 min-w-0 flex-1", styles.layout)}
      style={{
        "--thread-split-parent-min": `${THREAD_SPLIT_PARENT_MIN_WIDTH}px`,
        "--thread-split-thread-min": `${THREAD_SPLIT_PANEL_MIN_WIDTH}px`,
        "--thread-split-thread-max": `${THREAD_SPLIT_PANEL_MAX_WIDTH}px`,
      } as CSSProperties}
    >
      <ResizablePanelGroup
        id="community-thread-split-layout"
        orientation="horizontal"
        groupRef={groupRef}
        defaultLayout={hydratedClient ? defaultLayout : undefined}
        onLayoutChanged={split && !resolvingParent ? handleLayoutChanged : undefined}
        disabled={!split || resolvingParent}
        aria-hidden={resolvingParent || undefined}
        inert={resolvingParent || undefined}
        className={cn("min-h-0 flex-1", resolvingParent && "invisible", !split && !layoutPending && [
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
          minSize={THREAD_SPLIT_PARENT_MIN_WIDTH}
          disabled={!split || resolvingParent}
          data-layout-hidden={!split && !layoutPending || undefined}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {(split || layoutPending) && <section
            data-testid={tid.threadSplitParent}
            data-thread-parent
            inert={!split}
            aria-hidden={!split || undefined}
            aria-label="Parent conversation"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {parent}
          </section>}
        </ResizablePanel>
        {(split && !resolvingParent || layoutPending) && <ResizableHandle
          aria-label="Resize thread panel"
          disabled={!split || resolvingParent}
          className="bg-border/60"
        />}
        <ResizablePanel
          id="thread"
          defaultSize="44%"
          minSize={THREAD_SPLIT_PANEL_MIN_WIDTH}
          maxSize={THREAD_SPLIT_PANEL_MAX_WIDTH}
          disabled={!split || resolvingParent}
          data-layout-active={!split && !layoutPending || undefined}
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
