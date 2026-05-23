import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import type { SkillEntry } from "@alook/shared"

export interface SlashCommandPopupState {
  isOpen: boolean
  query: string
  selectedIndex: number
  anchorPos: { top: number; left: number }
  skills: SkillEntry[]
  handleSlashKeyDown: (e: React.KeyboardEvent) => boolean
  selectSkill: (skill: SkillEntry) => void
}

interface UseSlashCommandParams {
  input: string
  caretIndex: number | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  skills: SkillEntry[]
  onInputChange: (value: string) => void
}

const MAX_QUERY_LENGTH = 30
const POPUP_WIDTH = 280

function findSlashTrigger(input: string, caretIndex: number): { start: number; query: string } | null {
  let i = caretIndex - 1
  while (i >= 0 && caretIndex - i <= MAX_QUERY_LENGTH) {
    const ch = input.charCodeAt(i)
    if (ch === 47) { // '/'
      if (i === 0 || /\s/.test(input[i - 1])) {
        return { start: i, query: input.slice(i + 1, caretIndex) }
      }
      return null
    }
    if (ch === 10 || ch === 13 || ch === 32) return null
    i--
  }
  return null
}

function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const mirror = document.createElement("div")
  const style = window.getComputedStyle(textarea)

  const props = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "textTransform", "wordSpacing", "textIndent", "lineHeight",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "boxSizing", "whiteSpace", "wordWrap", "overflowWrap",
  ] as const

  mirror.style.position = "absolute"
  mirror.style.top = "-9999px"
  mirror.style.left = "-9999px"
  mirror.style.visibility = "hidden"
  mirror.style.overflow = "hidden"
  mirror.style.width = `${textarea.offsetWidth}px`

  for (const prop of props) {
    (mirror.style as unknown as Record<string, string>)[prop] = style.getPropertyValue(
      prop.replace(/([A-Z])/g, "-$1").toLowerCase()
    )
  }

  const textBefore = textarea.value.slice(0, position)
  mirror.textContent = textBefore
  const marker = document.createElement("span")
  marker.textContent = "​"
  mirror.appendChild(marker)

  document.body.appendChild(mirror)
  const top = marker.offsetTop - textarea.scrollTop
  const left = Math.max(0, Math.min(marker.offsetLeft, textarea.offsetWidth - POPUP_WIDTH))
  document.body.removeChild(mirror)

  return { top, left }
}

export function useSlashCommand({
  input,
  caretIndex,
  textareaRef,
  skills,
  onInputChange,
}: UseSlashCommandParams): SlashCommandPopupState {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 })
  const triggerStartRef = useRef<number | null>(null)

  const filteredSkills = useMemo(() => {
    if (!isOpen) return []
    if (!query) return skills.slice(0, 20)
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

  useEffect(() => {
    if (caretIndex === null) {
      setIsOpen(false)
      return
    }

    const trigger = findSlashTrigger(input, caretIndex)
    if (trigger) {
      triggerStartRef.current = trigger.start
      setQuery(trigger.query)
      setIsOpen(true)

      if (textareaRef.current) {
        const coords = getCaretCoordinates(textareaRef.current, trigger.start)
        setAnchorPos(coords)
      }
    } else {
      setIsOpen(false)
      triggerStartRef.current = null
    }
  }, [input, caretIndex, textareaRef])

  const selectSkill = useCallback((skill: SkillEntry) => {
    if (caretIndex === null || triggerStartRef.current === null) return

    const before = input.slice(0, triggerStartRef.current)
    const after = input.slice(caretIndex)
    const newInput = `${before}/${skill.name} ${after}`
    onInputChange(newInput)
    setIsOpen(false)

    const newCaretPos = before.length + 1 + skill.name.length + 1
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(newCaretPos, newCaretPos)
      }
    })
  }, [input, caretIndex, textareaRef, onInputChange])

  const handleSlashKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!isOpen || filteredSkills.length === 0) return false
    if (e.nativeEvent.isComposing) return false

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
    handleSlashKeyDown,
    selectSkill,
  }
}
