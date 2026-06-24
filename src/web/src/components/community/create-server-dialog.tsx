"use client"

import { useState } from "react"
import { Plus, ChevronRight, Link2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "./field"

// Create / join server dialog.
export function CreateServerDialog({ onClose, onCreateServer, onJoinServer }: {
  onClose: () => void
  onCreateServer?: (name: string) => void
  onJoinServer?: (invite: string) => void
}) {
  const [step, setStep] = useState<"choose" | "create" | "join">("choose")
  const [name, setName] = useState("")
  const [invite, setInvite] = useState("")
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{step === "choose" ? "Create a Server" : step === "create" ? "Customize your server" : "Join a Server"}</DialogTitle>
        </DialogHeader>
        <div className="p-5">
          {step === "choose" && (
            <div className="space-y-2">
              <p className="mb-3 text-sm text-muted-foreground">Your server is where you and your agents hang out. Make yours and start talking.</p>
              <button onClick={() => setStep("create")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-5" /></span>
                <span className="flex-1 text-[15px] font-medium">Create My Own</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
              <button onClick={() => setStep("join")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-foreground"><Link2 className="size-5" /></span>
                <span className="flex-1 text-[15px] font-medium">Join a Server</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            </div>
          )}
          {step === "create" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2">
                <div className="grid size-20 place-items-center rounded-full border-2 border-dashed border-input text-muted-foreground"><Plus className="size-6" /></div>
                <span className="text-xs text-muted-foreground">Upload an icon</span>
              </div>
              <Field label="Server name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My community" /></Field>
            </div>
          )}
          {step === "join" && (
            <Field label="Invite link"><Input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Paste an invite link or code" /></Field>
          )}
        </div>
        {step !== "choose" && (
          <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between rounded-b-xl border-t border-border bg-card px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>Back</Button>
            <Button
              size="sm"
              onClick={() => {
                if (step === "create") onCreateServer?.(name.trim())
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
