import React, { useRef, useEffect } from "react"
import type { SkillEntry } from "@alook/shared"
import { cn } from "@/lib/utils"

interface SlashCommandPopupProps {
  isOpen: boolean
  skills: SkillEntry[]
  selectedIndex: number
  onSelect: (skill: SkillEntry) => void
  anchorPos: { top: number; left: number }
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
        "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left text-sm transition-colors",
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
          <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
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

export function SlashCommandPopup({ isOpen, skills, selectedIndex, onSelect, anchorPos }: SlashCommandPopupProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll("[data-slash-item]")
    const selected = items[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (!isOpen || skills.length === 0) return null

  return (
    <div
      className="absolute z-50 w-70 rounded-lg border border-border bg-popover text-popover-foreground shadow-md transition-opacity duration-150"
      style={{
        top: anchorPos.top - 4,
        left: anchorPos.left,
        transform: "translateY(-100%)",
      }}
    >
      <div ref={listRef} className="max-h-60 overflow-y-auto py-1 thin-scrollbar">
        {skills.map((skill, i) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            isSelected={i === selectedIndex}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
