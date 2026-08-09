"use client"

import { useId, useRef, useState } from "react"
import { ImagePlus } from "lucide-react"
import { toast } from "sonner"
import { SeededBackdrop } from "@/components/avatar"
import { Button } from "@/components/ui/button"
import { avatarInitial } from "@/lib/community/avatar"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import { previewSlug } from "@/lib/community/slug-preview"
import { tid } from "@/lib/community/testids"
import { CreateDialogShell } from "./create-dialog-shell"
import { ImageCropDialog } from "./image-crop-dialog"
import { SlugHint } from "./slug-hint"

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function playNameImpact(
  input: HTMLInputElement,
  avatar: HTMLButtonElement | null,
  direction: 1 | -1,
  currentAnimations: { dialog: Animation | null; avatar: Animation | null },
) {
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return currentAnimations

  const dialog = input.closest<HTMLElement>("[role='dialog']")
  if (!dialog || typeof dialog.animate !== "function") return currentAnimations

  currentAnimations.dialog?.cancel()
  currentAnimations.avatar?.cancel()

  // A short, low-amplitude hit: enough to make each character feel physical,
  // while keeping the input caret readable and the dialog anchored in place.
  // `margin-*` and individual `scale` deliberately avoid clobbering the
  // translate transform that centers DialogContent.
  const dialogAnimation = dialog.animate(
    [
      { marginLeft: "0px", marginTop: "0px", scale: "1" },
      { marginLeft: `${direction * 1.75}px`, marginTop: "0.5px", scale: "0.994", offset: 0.24 },
      { marginLeft: `${direction * -0.8}px`, marginTop: "-0.75px", scale: "1.003", offset: 0.58 },
      { marginLeft: "0px", marginTop: "0px", scale: "1" },
    ],
    { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" },
  )

  const avatarAnimation = avatar?.animate(
    [
      { scale: "1", rotate: "0deg" },
      { scale: "0.92", rotate: `${direction * -1.5}deg`, offset: 0.24 },
      { scale: "1.07", rotate: `${direction * 0.8}deg`, offset: 0.62 },
      { scale: "1", rotate: "0deg" },
    ],
    { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" },
  ) ?? null

  return { dialog: dialogAnimation, avatar: avatarAnimation }
}

// The rail's plus button is an explicit create action. Invite links already
// own the join journey, so this dialog stays single-purpose and name-first.
export function CreateServerDialog({ onClose, onCreateServer }: {
  onClose: () => void
  onCreateServer?: (name: string, icon?: File) => void
}) {
  const [name, setName] = useState("")
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const [pendingCropSrc, setPendingCropSrc] = useState<{ src: string; fileName: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  const impactDirectionRef = useRef<1 | -1>(1)
  const impactAnimationsRef = useRef<{ dialog: Animation | null; avatar: Animation | null }>({ dialog: null, avatar: null })
  const previewSeed = `new-server-${useId()}`

  const namePreview = previewSlug(name)
  const initial = name.trim() ? avatarInitial(name) : null
  const pickIcon = () => fileRef.current?.click()
  const submit = () => {
    if (!namePreview.slug) return
    onCreateServer?.(name.trim(), iconFile ?? undefined)
    onClose()
  }
  const onNameChange = (nextName: string) => {
    setName(nextName)
    const input = nameRef.current
    if (!input || nextName === name) return
    impactDirectionRef.current = impactDirectionRef.current === 1 ? -1 : 1
    impactAnimationsRef.current = playNameImpact(
      input,
      avatarRef.current,
      impactDirectionRef.current,
      impactAnimationsRef.current,
    )
  }
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const check = validateIconSourceFile(file)
    if (!check.ok) {
      toast.error(check.error)
      return
    }
    setPendingCropSrc({ src: URL.createObjectURL(file), fileName: file.name })
  }

  return (
    <>
      <CreateDialogShell
        onClose={onClose}
        title="Create a server"
        footer={(
          <Button
            size="sm"
            data-testid={tid.createServerSubmit}
            disabled={!namePreview.slug}
            onClick={submit}
          >
            Create server
          </Button>
        )}
      >
        <div className="px-5 pb-1">
          <div className="flex items-center gap-4">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={onFileChange}
            />
            <button
              ref={avatarRef}
              type="button"
              onClick={pickIcon}
              aria-label="Upload server icon"
              className="group relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl text-white ring-1 ring-border/40 outline-none transition-[box-shadow,filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]"
            >
              {iconPreview ? (
                <img src={iconPreview} alt="" className="size-full object-cover" />
              ) : (
                <>
                  <SeededBackdrop seed={previewSeed} />
                  {initial ? (
                    <span className="relative -translate-x-0.5 font-brand text-[2rem] font-bold leading-none [-webkit-text-stroke:0.5px_currentColor]">
                      {initial}
                    </span>
                  ) : (
                    <ImagePlus className="relative size-5 opacity-70 drop-shadow-sm" />
                  )}
                </>
              )}
              <span className="absolute inset-0 grid place-items-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <ImagePlus className="size-4 drop-shadow-sm" />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submit()
                }}
                placeholder="My community"
                autoFocus
                aria-label="Server name"
                className="w-full border-0 bg-transparent p-0 text-[26px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/35 focus-visible:ring-0"
              />
              <SlugHint {...namePreview} />
            </div>
          </div>
        </div>
      </CreateDialogShell>
      {pendingCropSrc && (
        <ImageCropDialog
          imageSrc={pendingCropSrc.src}
          originalFileName={pendingCropSrc.fileName}
          maskShape="square"
          onCropped={(file) => {
            setIconFile(file)
            setIconPreview((prev) => {
              if (prev) URL.revokeObjectURL(prev)
              return URL.createObjectURL(file)
            })
            URL.revokeObjectURL(pendingCropSrc.src)
            setPendingCropSrc(null)
          }}
          onCancel={() => {
            URL.revokeObjectURL(pendingCropSrc.src)
            setPendingCropSrc(null)
          }}
        />
      )}
    </>
  )
}
