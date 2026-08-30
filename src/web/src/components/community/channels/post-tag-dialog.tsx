"use client"

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react"
import { X } from "lucide-react"
import { FORUM_ARCHIVE_TAG, MAX_FORUM_TAG_LENGTH, MAX_FORUM_TAGS_PER_POST } from "@alook/shared"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBreakpoint, type Breakpoint } from "@/hooks/use-mobile"
import { onEnterSubmit } from "@/lib/ime"
import { tid } from "@/lib/community/testids"
import { tagColorClassName, tagColorStyle } from "@/lib/community/tag-color"
import { cn } from "@/lib/utils"

type ResolvedShell = Exclude<Breakpoint, "unknown">

type TagEditorBodyProps = {
  selected: string[]
  draft: string
  chips: string[]
  ordinaryTagCount: number
  busy: boolean
  mobile: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onDraftChange: (value: string) => void
  onToggle: (tag: string) => void
  onAddDraft: () => void
}

function PostTagEditorBody({
  selected,
  draft,
  chips,
  ordinaryTagCount,
  busy,
  mobile,
  inputRef,
  onDraftChange,
  onToggle,
  onAddDraft,
}: TagEditorBodyProps) {
  return (
    <div
      data-testid={tid.forumTagDialogBody}
      className={cn(
        "space-y-3",
        mobile && "min-h-0 flex-1 overflow-y-auto thin-scrollbar px-4 py-3",
      )}
    >
      {!mobile && (
        <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground">TAGS</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {chips.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tags yet</p>
        ) : chips.map((tag) => {
          const active = selected.includes(tag)
          const additionBlocked = !active && (
            (tag !== FORUM_ARCHIVE_TAG && ordinaryTagCount >= MAX_FORUM_TAGS_PER_POST)
            || tag.length > MAX_FORUM_TAG_LENGTH
          )
          return (
            <button
              key={tag}
              type="button"
              data-testid={tid.forumTagDialogChip(tag)}
              disabled={busy || additionBlocked}
              aria-label={`${active ? "Remove" : "Add"} tag ${tag}`}
              title={`#${tag}`}
              style={tagColorStyle(tag)}
              className={cn(
                "inline-flex max-w-full min-w-0 items-center rounded-lg px-2 py-1 text-xs transition-opacity disabled:cursor-not-allowed disabled:opacity-40",
                mobile && "min-h-11 min-w-11",
                tagColorClassName,
                active ? "opacity-100 ring-1 ring-current/20" : "opacity-55 hover:opacity-80",
              )}
              onClick={() => onToggle(tag)}
            >
              <span className="min-w-0 truncate">#{tag}</span>
              {active && <X aria-hidden="true" className="ml-1 size-3 shrink-0" />}
            </button>
          )
        })}
      </div>

      <Input
        ref={inputRef}
        data-testid={tid.forumTagDialogInput}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value.slice(0, MAX_FORUM_TAG_LENGTH))}
        onKeyDown={onEnterSubmit(onAddDraft)}
        maxLength={MAX_FORUM_TAG_LENGTH}
        placeholder="Add a tag…"
        className={cn("text-sm", mobile ? "h-11" : "h-8")}
        disabled={busy || ordinaryTagCount >= MAX_FORUM_TAGS_PER_POST}
      />

      <p className="text-right text-[11px] text-muted-foreground">
        {busy ? "Saving…" : mobile ? "↵ to add" : "↵ to add · saves on close"}
      </p>
    </div>
  )
}

export function PostTagDialog({
  trigger,
  postName,
  current,
  allTags,
  onSave,
  saving,
}: {
  trigger: ReactElement
  postName: string
  current: string[]
  allTags: string[]
  onSave: (tags: string[]) => Promise<void> | void
  saving?: boolean
}) {
  const breakpoint = useBreakpoint()
  const shell: ResolvedShell | null = breakpoint === "unknown" ? null : breakpoint
  const activeShellRef = useRef<ResolvedShell | null>(shell)

  const [open, setOpen] = useState(false)
  const [baseline, setBaseline] = useState<string[]>(current)
  const [selected, setSelected] = useState<string[]>(current)
  const [draft, setDraft] = useState("")
  const [committing, setCommitting] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousShellRef = useRef<ResolvedShell | null>(shell)
  const previousOpenRef = useRef(open)
  const busy = !!saving || committing
  const ordinaryTagCount = selected.filter((tag) => tag !== FORUM_ARCHIVE_TAG).length
  const changed = selected.length !== baseline.length
    || selected.some((tag, index) => tag !== baseline[index])

  useLayoutEffect(() => {
    activeShellRef.current = shell
  }, [shell])

  useEffect(() => {
    if (!open) {
      setBaseline(current)
      setSelected(current)
    }
  }, [current, open])

  useEffect(() => {
    const previousShell = previousShellRef.current
    previousShellRef.current = shell
    if (!open || !previousShell || !shell || previousShell === shell) return
    if (!busy && inputRef.current) {
      inputRef.current.focus()
      return
    }
    surfaceRef.current?.focus()
  }, [busy, open, shell])

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (wasOpen && !open) triggerRef.current?.focus()
  }, [open])

  const begin = () => {
    if (open) return
    setBaseline(current)
    setSelected(current)
    setDraft("")
    setOpen(true)
  }

  const finish = () => {
    setOpen(false)
    setDraft("")
  }

  const discard = () => {
    if (busy) return
    setSelected(current)
    finish()
  }

  const toggle = (tag: string) => {
    setSelected((previous) => {
      if (previous.includes(tag)) return previous.filter((candidate) => candidate !== tag)
      const ordinaryCount = previous.filter((candidate) => candidate !== FORUM_ARCHIVE_TAG).length
      if (
        (tag !== FORUM_ARCHIVE_TAG && ordinaryCount >= MAX_FORUM_TAGS_PER_POST)
        || tag.length > MAX_FORUM_TAG_LENGTH
      ) {
        return previous
      }
      return [...previous, tag]
    })
  }

  const addDraft = () => {
    const tag = draft.trim().toLowerCase()
    if (!tag || tag.length > MAX_FORUM_TAG_LENGTH) return
    setSelected((previous) => {
      const ordinaryCount = previous.filter((candidate) => candidate !== FORUM_ARCHIVE_TAG).length
      if (
        previous.includes(tag)
        || (tag !== FORUM_ARCHIVE_TAG && ordinaryCount >= MAX_FORUM_TAGS_PER_POST)
      ) return previous
      return [...previous, tag]
    })
    setDraft("")
  }

  const closeDesktop = () => {
    if (busy) return
    finish()
    if (!changed) return
    try {
      void Promise.resolve(onSave(selected)).catch(() => undefined)
    } catch {
      return
    }
  }

  const saveMobile = async () => {
    if (busy) return
    if (!changed) {
      finish()
      return
    }
    setCommitting(true)
    try {
      await onSave(selected)
      finish()
    } catch {
      return
    } finally {
      setCommitting(false)
    }
  }

  const onShellOpenChange = (origin: ResolvedShell, nextOpen: boolean) => {
    if (nextOpen) {
      begin()
      return
    }
    if (activeShellRef.current !== origin || busy) return
    if (origin === "mobile") discard()
    else closeDesktop()
  }

  const chips = [
    FORUM_ARCHIVE_TAG,
    ...[...new Set([...allTags, ...selected])]
      .filter((tag) => tag !== FORUM_ARCHIVE_TAG)
      .sort(),
  ]

  const body = (mobile: boolean) => (
    <PostTagEditorBody
      selected={selected}
      draft={draft}
      chips={chips}
      ordinaryTagCount={ordinaryTagCount}
      busy={busy}
      mobile={mobile}
      inputRef={inputRef}
      onDraftChange={setDraft}
      onToggle={toggle}
      onAddDraft={addDraft}
    />
  )

  if (!shell) return trigger

  if (shell === "mobile") {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => onShellOpenChange("mobile", nextOpen)}>
        <DialogTrigger ref={triggerRef} render={trigger} />
        <DialogContent
          ref={surfaceRef}
          tabIndex={-1}
          showCloseButton={false}
          data-testid={tid.forumTagDialog}
          aria-label={`Edit tags for ${postName}`}
          className="flex max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full flex-col gap-0 p-0"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 py-3 pr-2 pl-4">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
              Edit tags for {postName}
            </DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Close"
              disabled={busy}
              onClick={discard}
            >
              <X aria-hidden="true" />
            </Button>
          </div>

          {body(true)}

          <div className="flex shrink-0 justify-end gap-2 border-t border-border/50 p-4">
            <Button
              type="button"
              variant="outline"
              className="h-11 px-4"
              data-testid={tid.forumTagDialogCancel}
              disabled={busy}
              onClick={discard}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-11 px-4"
              data-testid={tid.forumTagDialogSave}
              disabled={busy}
              onClick={() => void saveMobile()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Popover open={open} onOpenChange={(nextOpen) => onShellOpenChange("desktop", nextOpen)}>
      <PopoverTrigger ref={triggerRef} render={trigger} />
      <PopoverContent
        ref={surfaceRef}
        tabIndex={-1}
        side="bottom"
        align="end"
        className="w-64 space-y-3 p-3"
        data-testid={tid.forumTagDialog}
        aria-label={`Edit tags for ${postName}`}
        onClick={(event) => event.stopPropagation()}
      >
        {body(false)}
      </PopoverContent>
    </Popover>
  )
}
