"use client"

import { useRef, useState } from "react"
import { Plus, ChevronRight, Link2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "./field"

// Create / join server dialog.
export function CreateServerDialog({ onClose, onCreateServer, onJoinServer }: {
  onClose: () => void
  onCreateServer?: (name: string, icon?: File) => void
  onJoinServer?: (invite: string) => void
}) {
  const [step, setStep] = useState<"choose" | "create" | "join">("choose")
  const [name, setName] = useState("")
  const [invite, setInvite] = useState("")
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickIcon = () => fileRef.current?.click()
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIconFile(file)
    setIconPreview(URL.createObjectURL(file))
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle>{step === "choose" ? "Create a Server" : step === "create" ? "Customize your server" : "Join a Server"}</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-5">
          {step === "choose" && (
            <div className="space-y-2">
              <p className="mb-3 text-sm text-muted-foreground">Your server is where you and your agents hang out. Make yours and start talking.</p>
              <button onClick={() => setStep("create")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-5" /></span>
                <span className="flex-1 text-sm font-medium">Create a server</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
              <button onClick={() => setStep("join")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-foreground"><Link2 className="size-5" /></span>
                <span className="flex-1 text-sm font-medium">Join with invite</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            </div>
          )}
          {step === "create" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2">
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
                <button onClick={pickIcon} className="grid size-20 place-items-center overflow-hidden rounded-full border-2 border-dashed border-input text-muted-foreground hover:border-primary hover:text-foreground">
                  {iconPreview ? (
                    <img src={iconPreview} alt="" className="size-full object-cover" />
                  ) : (
                    <Plus className="size-6" />
                  )}
                </button>
                <span className="text-xs text-muted-foreground">{iconPreview ? "Change icon" : "Upload an icon"}</span>
              </div>
              <Field label="Server name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My community" /></Field>
            </div>
          )}
          {step === "join" && (
            <Field label="Invite link"><Input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Paste an invite link or code" /></Field>
          )}
        </div>
        {step !== "choose" && (
          <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between rounded-b-xl border-t border-border bg-card px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>Back</Button>
            <Button
              size="sm"
              disabled={step === "create" ? !name.trim() : !invite.trim()}
              onClick={() => {
                if (step === "create") onCreateServer?.(name.trim(), iconFile ?? undefined)
                else onJoinServer?.(invite.trim())
                onClose()
              }}
            >
              {step === "create" ? "Create" : "Join Server"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
