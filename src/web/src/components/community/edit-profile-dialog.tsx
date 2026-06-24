"use client"

import { useState } from "react"
import { User, LogOut, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Field } from "./field"

// Full-screen User Settings dialog — same style as Server Settings (left nav + right content).
export function UserSettings({ onClose, aboutMe, onSave, onLogout }: {
  onClose: () => void
  aboutMe: string
  onSave: (aboutMe: string) => void
  onLogout?: () => void
}) {
  const [value, setValue] = useState(aboutMe)
  const save = () => onSave(value.trim())
  return (
    <Tabs
      orientation="vertical"
      defaultValue="profile"
      className="min-h-0 flex-1 flex-row gap-0"
    >
      <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar border-r border-border p-3" style={{ background: "var(--d-rail)" }}>
        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">User Settings</div>
        <TabsList variant="line" className="h-auto w-full flex-col gap-0.5">
          <TabsTrigger value="profile" className="h-8 w-full justify-start gap-2">
            <User className="size-4" /> My Profile
          </TabsTrigger>
        </TabsList>
        <Separator className="my-1" />
        <Button variant="ghost" className="justify-start text-destructive hover:text-destructive" size="sm" onClick={onLogout}>
          <LogOut className="size-4" /> Log Out
        </Button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="flex-1 text-lg font-semibold">My Profile</h1>
          <button onClick={onClose} className="flex flex-col items-center text-muted-foreground hover:text-foreground" aria-label="Close settings">
            <span className="grid size-8 place-items-center rounded-full border border-current"><X className="size-4" /></span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto thin-scrollbar p-5">
          <TabsContent value="profile">
            <div className="max-w-xl space-y-5">
              <Field label="About Me">
                <Textarea className="h-24 resize-none" value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} />
              </Field>
            </div>
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}
