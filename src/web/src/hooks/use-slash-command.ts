import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import type { SkillEntry } from "@alook/shared"

/**
 * Minimal keyboard-event shape the popup hooks need. Both React synthetic
 * events and native KeyboardEvents (from TipTap's editorProps.handleKeyDown,
 * wrapped) satisfy it, so the same hook drives the textarea and the composer.
 */
export interface PopupKeyEvent {
  key: string
  isComposing: boolean
  preventDefault: () => void
}

export interface SlashCommandPopupState {
  isOpen: boolean
  query: string
  selectedIndex: number
  anchorPos: { top: number; left: number }
  skills: SkillEntry[]
  activeSkill: SkillEntry | null
  handleSlashKeyDown: (e: PopupKeyEvent) => boolean
  selectSkill: (skill: SkillEntry) => void
  clearActiveSkill: () => void
  setActiveSkill: (skill: SkillEntry | null) => void
}

interface UseSlashCommandParams {
  input: string
  caretIndex: number | null
  skills: SkillEntry[]
  onInputChange: (value: string) => void
  initialActiveSkill?: SkillEntry | null
  /**
   * Resolve the popup anchor position (viewport-relative top/left) for the
   * slash trigger at `triggerStart`. The TipTap composer computes this from
   * `editor.view.coordsAtPos`; returns null if it cannot be resolved yet.
   */
  getAnchorPos: (triggerStart: number) => { top: number; left: number } | null
  /** Called after a skill is selected so the caller can re-focus its editor. */
  onAfterSelect?: () => void
}

const MAX_QUERY_LENGTH = 30

function findSlashTrigger(input: string, caretIndex: number): { start: number; query: string } | null {
  if (!input.startsWith("/")) return null
  if (caretIndex === 0) return null
  let i = caretIndex - 1
  while (i >= 0 && caretIndex - i <= MAX_QUERY_LENGTH) {
    const ch = input.charCodeAt(i)
    if (ch === 47 && i === 0) { // '/' at position 0 only
      return { start: 0, query: input.slice(1, caretIndex) }
    }
    if (ch === 10 || ch === 13 || ch === 32) return null
    i--
  }
  return null
}

export function useSlashCommand({
  input,
  caretIndex,
  skills,
  onInputChange,
  initialActiveSkill,
  getAnchorPos,
  onAfterSelect,
}: UseSlashCommandParams): SlashCommandPopupState {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 })
  const triggerStartRef = useRef<number | null>(null)

  const filteredSkills = useMemo(() => {
    if (!isOpen) return []
    if (!query) return skills
    const q = query.toLowerCase()
    const startsWith: SkillEntry[] = []
    const includes: SkillEntry[] = []
    for (const s of skills) {
      const name = s.name.toLowerCase()
      if (name.startsWith(q)) startsWith.push(s)
      else if (name.includes(q)) includes.push(s)
    }
    return [...startsWith, ...includes]
  }, [isOpen, query, skills])

  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredSkills.length, query])

  const [activeSkill, setActiveSkill] = useState<SkillEntry | null>(initialActiveSkill ?? null)

  useEffect(() => {
    if (activeSkill) {
      setIsOpen(false)
      return
    }
    if (caretIndex === null) {
      setIsOpen(false)
      return
    }

    const trigger = findSlashTrigger(input, caretIndex)
    if (trigger) {
      triggerStartRef.current = trigger.start
      setQuery(trigger.query)
      setIsOpen(true)

      const coords = getAnchorPos(trigger.start)
      if (coords) setAnchorPos(coords)
    } else {
      setIsOpen(false)
      triggerStartRef.current = null
    }
  }, [input, caretIndex, getAnchorPos, activeSkill])

  const selectSkill = useCallback((skill: SkillEntry) => {
    setActiveSkill(skill)
    onInputChange("")
    setIsOpen(false)
    onAfterSelect?.()
  }, [onInputChange, onAfterSelect])

  const clearActiveSkill = useCallback(() => {
    setActiveSkill(null)
  }, [])

  const handleSlashKeyDown = useCallback((e: PopupKeyEvent): boolean => {
    if (!isOpen || filteredSkills.length === 0) return false
    if (e.isComposing) return false

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex(i => (i + 1) % filteredSkills.length)
      return true
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex(i => (i - 1 + filteredSkills.length) % filteredSkills.length)
      return true
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      selectSkill(filteredSkills[selectedIndex])
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setIsOpen(false)
      return true
    }
    return false
  }, [isOpen, filteredSkills, selectedIndex, selectSkill])

  return {
    isOpen,
    query,
    selectedIndex,
    anchorPos,
    skills: filteredSkills,
    activeSkill,
    handleSlashKeyDown,
    selectSkill,
    clearActiveSkill,
    setActiveSkill,
  }
}
