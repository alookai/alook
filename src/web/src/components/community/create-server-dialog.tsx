"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { Plus, ChevronRight, Link2 } from "lucide-react"
import { CreateDialogShell } from "./create-dialog-shell"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { SlugHint } from "./slug-hint"
import { ImageCropDialog } from "./image-crop-dialog"
import { previewSlug } from "@/lib/community/slug-preview"
import { validateIconSourceFile } from "@/lib/community/image-crop"

// Create / join server dialog.
export function CreateServerDialog({ onClose, onCreateServer, onJoinServer, initialStep = "choose" }: {
  onClose: () => void
  onCreateServer?: (name: string, icon?: File) => void
  onJoinServer?: (invite: string) => void
  initialStep?: "choose" | "create" | "join"
}) {
  const [step, setStep] = useState<"choose" | "create" | "join">(initialStep)
  const [name, setName] = useState("")
  const [invite, setInvite] = useState("")
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const [pendingCropSrc, setPendingCropSrc] = useState<{ src: string; fileName: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const namePreview = previewSlug(name)
  const pickIcon = () => fileRef.current?.click()
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
        mutedTitle={step !== "choose"}
        title={step === "choose" ? "Create a Server" : step === "create" ? "Customize your server" : "Join a Server"}
        footerClassName="justify-between"
        footer={step === "choose" ? undefined : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>Back</Button>
            <Button
              size="sm"
              data-testid={tid.createServerSubmit}
              disabled={step === "create" ? !namePreview.slug : !invite.trim()}
              onClick={() => {
                if (step === "create") onCreateServer?.(name.trim(), iconFile ?? undefined)
                else onJoinServer?.(invite.trim())
                onClose()
              }}
            >
              {step === "create" ? "Create" : "Join Server"}
            </Button>
          </>
        )}
      >
          <div className="px-5 pb-5">
            {step === "choose" && (
              <div className="space-y-1">
                <p className="mb-3 text-sm text-muted-foreground">Your server is where you and your agents hang out. Make yours and start talking.</p>
                {/* Frameless hover rows — the icon chip carries the accent, no box. */}
                <button onClick={() => setStep("create")} className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-accent/40">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-5" /></span>
                  <span className="flex-1 text-sm font-medium">Create a server</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
                <button onClick={() => setStep("join")} className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-accent/40">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-foreground"><Link2 className="size-5" /></span>
                  <span className="flex-1 text-sm font-medium">Join with invite</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              </div>
            )}
            {step === "create" && (
              <div className="flex flex-col items-center gap-4 pt-2">
                {/* Icon = centered on top, the single upload affordance (the
                    dropzone IS the button — no redundant separate upload pill).
                    A server's identity is visual, so the icon leads. NOT
                    ServerIcon: no server id/marble seed pre-creation. */}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onFileChange} />
                <button onClick={pickIcon} className="group grid size-24 shrink-0 place-items-center overflow-hidden rounded-2xl ring-1 ring-border/50 text-muted-foreground transition-colors hover:text-foreground hover:ring-primary/60">
                  {iconPreview ? (
                    <img src={iconPreview} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="flex flex-col items-center gap-1">
                      <Plus className="size-6" />
                      <span className="text-[10px] font-medium">Upload icon</span>
                    </span>
                  )}
                </button>
                {/* Server name below the icon — left-aligned so the cursor sits
                    at a consistent left position (a centered input makes the
                    caret jump around as you type). */}
                <div className="w-full">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My community"
                    autoFocus
                    aria-label="Server name"
                    className="w-full border-0 bg-transparent p-0 text-[26px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
                  />
                  <SlugHint {...namePreview} />
                </div>
              </div>
            )}
            {step === "join" && (
              <div className="pt-2">
                <input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="Paste an invite link or code"
                  autoFocus
                  aria-label="Invite link"
                  className="w-full border-0 bg-transparent p-0 text-lg shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
                />
              </div>
            )}
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
