/* Hallmark · modern-minimal · focused/utilitarian · inherited neutral palette
 * macrostructure: parallel-conversation-panel · pre-emit: P5 H5 E4 S5 R5 V4 · slop: pass
 */
import type { ReactNode, RefCallback } from "react"
import { cn } from "@/lib/utils"
import { tid } from "@/lib/community/testids"

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
  return (
    <main
      ref={containerRef}
      data-testid={tid.threadSplit}
      data-layout={split ? "split" : "full"}
      className="flex min-h-0 min-w-0 flex-1"
    >
      {split && (
        <section
          data-testid={tid.threadSplitParent}
          aria-label="Parent conversation"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {parent}
        </section>
      )}
      <section
        data-testid={tid.threadSplitPanel}
        aria-label={split ? "Thread panel" : "Thread"}
        className={cn(
          "flex min-h-0 min-w-0 flex-col bg-background",
          split
            ? "w-[clamp(26rem,44%,32rem)] shrink-0 border-l border-border/60"
            : "flex-1",
        )}
      >
        {thread}
      </section>
    </main>
  )
}
