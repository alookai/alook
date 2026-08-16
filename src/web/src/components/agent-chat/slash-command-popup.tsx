import React, { useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import type { SkillEntry } from "@alook/shared"
import { cn } from "@/lib/utils"
import {
  anchoredPopoverStyle,
  useAnchoredPopover,
  type AnchorRectResolver,
} from "@/hooks/use-anchored-popover"

interface SlashCommandPopupProps {
  isOpen: boolean
  skills: SkillEntry[]
  selectedIndex: number
  onSelect: (skill: SkillEntry) => void
  getAnchorRect: AnchorRectResolver
}

function SkillRow({
  skill,
  isSelected,
  onSelect,
}: {
  skill: SkillEntry
  isSelected: boolean
  onSelect: (skill: SkillEntry) => void
}) {
  return (
    <button
      type="button"
      data-slash-item
      className={cn(
        "flex w-full flex-col gap-1 px-3 py-2 text-left text-sm transition-colors",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onMouseDown={(e) => {
        e.preventDefault()
        onSelect(skill)
      }}
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">/{skill.name}</span>
        {skill.isGlobal && (
          <span className="shrink-0 rounded px-1 py-1 text-[10px] font-medium bg-muted text-muted-foreground">
            Global
          </span>
        )}
      </span>
      {skill.description && (
        <span className="truncate text-xs text-muted-foreground">
          {skill.description.slice(0, 80)}
        </span>
      )}
    </button>
  )
}

export function SlashCommandPopup({ isOpen, skills, selectedIndex, onSelect, getAnchorRect }: SlashCommandPopupProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const geometry = useAnchoredPopover(getAnchorRect, isOpen && skills.length > 0)

  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll("[data-slash-item]")
    const selected = items[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (!isOpen || skills.length === 0 || !geometry) return null

  return createPortal(
    <div
      className="fixed z-100 w-70 rounded-lg border border-border bg-popover text-popover-foreground shadow-md transition-opacity duration-150"
      style={anchoredPopoverStyle(geometry.rect, geometry.viewport, 280, 240)}
    >
      <div
        ref={listRef}
        className="overflow-y-auto py-1 thin-scrollbar"
        style={{ maxHeight: "var(--anchored-popover-max-height)" }}
      >
        {skills.map((skill, i) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            isSelected={i === selectedIndex}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>,
    document.body,
  )
}
