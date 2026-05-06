import React, { useRef, useEffect } from "react"
import type { Agent } from "@alook/shared"
import { cn } from "@/lib/utils"

interface MentionPopupProps {
  isOpen: boolean
  agents: Agent[]
  selectedIndex: number
  onSelect: (agent: Agent) => void
  anchorPos: { top: number; left: number }
}

export function MentionPopup({ isOpen, agents, selectedIndex, onSelect, anchorPos }: MentionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (!isOpen || agents.length === 0) return null

  return (
    <div
      className="absolute z-50 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-md transition-opacity duration-150"
      style={{
        top: anchorPos.top - 4,
        left: anchorPos.left,
        transform: "translateY(-100%)",
      }}
    >
      <div ref={listRef} className="max-h-50 overflow-y-auto py-1 thin-scrollbar">
        {agents.map((agent, i) => (
          <button
            key={agent.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
              i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(agent)
            }}
          >
            <span className="truncate font-medium">{agent.name}</span>
            {agent.email_handle && (
              <span className="truncate text-xs text-muted-foreground">
                {agent.email_handle}@alook.ai
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
