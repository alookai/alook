/* Hallmark · modern-minimal · focused/utilitarian · inherited neutral palette
 * macrostructure: parallel-conversation-panel · pre-emit: P5 H5 E4 S5 R5 V4 · slop: pass
 */
"use client"

import type { ReactNode, RefCallback } from "react"
import { useDefaultLayout } from "react-resizable-panels"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { tid } from "@/lib/community/testids"

export const THREAD_SPLIT_PANEL_MIN_WIDTH = 360
export const THREAD_SPLIT_PANEL_MAX_WIDTH = 800

const threadSplitLayoutStorage = {
  getItem: (key: string) => typeof window === "undefined" ? null : window.localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value)
  },
}

export function ThreadSplitView({
  containerRef,
  split,
  parent,
  thread,
}: {
  containerRef: RefCallback<HTMLElement>
  split: boolean
  parent: ReactNode
  thread: ReactNode
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "community-thread-split-layout",
    onlySaveAfterUserInteractions: true,
    storage: threadSplitLayoutStorage,
  })

  return (
    <main
      ref={containerRef}
      data-testid={tid.threadSplit}
      data-layout={split ? "split" : "full"}
      className="flex min-h-0 min-w-0 flex-1"
    >
      {split ? (
        <ResizablePanelGroup
          id="community-thread-split-layout"
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="parent"
            defaultSize="56%"
            minSize={320}
            className="flex min-h-0 min-w-0 flex-col"
          >
            <section
              data-testid={tid.threadSplitParent}
              aria-label="Parent conversation"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {parent}
            </section>
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize thread panel"
            className="bg-border/60"
          />
          <ResizablePanel
            id="thread"
            defaultSize="44%"
            minSize={THREAD_SPLIT_PANEL_MIN_WIDTH}
            maxSize={THREAD_SPLIT_PANEL_MAX_WIDTH}
            className="flex min-h-0 min-w-0 flex-col bg-background"
          >
            <section
              data-testid={tid.threadSplitPanel}
              aria-label="Thread panel"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {thread}
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <section
          data-testid={tid.threadSplitPanel}
          aria-label="Thread"
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
        >
          {thread}
        </section>
      )}
    </main>
  )
}
