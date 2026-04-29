import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import type { Agent } from "@alook/shared"

export interface MentionPopupState {
  isOpen: boolean
  query: string
  selectedIndex: number
  anchorPos: { top: number; left: number }
  filteredAgents: Agent[]
  handleMentionKeyDown: (e: React.KeyboardEvent) => boolean
  selectAgent: (agent: Agent) => void
}

interface UseMentionPopupParams {
  input: string
  caretIndex: number | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  agents: Agent[]
  onInputChange: (value: string) => void
}

function isTriggerChar(ch: number): boolean {
  if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) return false
  return true
}

function findMentionTrigger(input: string, caretIndex: number): { start: number; query: string } | null {
  let i = caretIndex - 1
  while (i >= 0) {
    const ch = input.charCodeAt(i)
    if (ch === 64) { // '@'
      if (i === 0 || isTriggerChar(input.charCodeAt(i - 1))) {
        return { start: i, query: input.slice(i + 1, caretIndex) }
      }
      return null
    }
    if (ch === 10 || ch === 13) return null // newline breaks the scan
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
  const left = marker.offsetLeft
  document.body.removeChild(mirror)

  return { top, left }
}

export function useMentionPopup({
  input,
  caretIndex,
  textareaRef,
  agents,
  onInputChange,
}: UseMentionPopupParams): MentionPopupState {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 })
  const triggerStartRef = useRef<number | null>(null)

  const filteredAgents = useMemo(() => {
    if (!isOpen) return []
    if (!query) return agents.slice(0, 20)
    const q = query.toLowerCase()
    const startsWith: Agent[] = []
    const includes: Agent[] = []
    for (const a of agents) {
      const name = a.name.toLowerCase()
      if (name.startsWith(q)) startsWith.push(a)
      else if (name.includes(q)) includes.push(a)
    }
    return [...startsWith, ...includes]
  }, [isOpen, query, agents])

  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredAgents.length, query])

  useEffect(() => {
    if (caretIndex === null) {
      setIsOpen(false)
      return
    }

    const trigger = findMentionTrigger(input, caretIndex)
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

  const selectAgent = useCallback((agent: Agent) => {
    if (caretIndex === null || triggerStartRef.current === null) return

    const before = input.slice(0, triggerStartRef.current)
    const after = input.slice(caretIndex)
    const newInput = `${before}@${agent.name} ${after}`
    onInputChange(newInput)
    setIsOpen(false)

    const newCaretPos = before.length + 1 + agent.name.length + 1
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(newCaretPos, newCaretPos)
      }
    })
  }, [input, caretIndex, textareaRef, onInputChange])

  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!isOpen || filteredAgents.length === 0) return false
    if (e.nativeEvent.isComposing) return false

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex(i => (i + 1) % filteredAgents.length)
      return true
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex(i => (i - 1 + filteredAgents.length) % filteredAgents.length)
      return true
    }
    if (e.key === "Enter") {
      e.preventDefault()
      selectAgent(filteredAgents[selectedIndex])
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setIsOpen(false)
      return true
    }
    return false
  }, [isOpen, filteredAgents, selectedIndex, selectAgent])

  return {
    isOpen,
    query,
    selectedIndex,
    anchorPos,
    filteredAgents,
    handleMentionKeyDown,
    selectAgent,
  }
}
