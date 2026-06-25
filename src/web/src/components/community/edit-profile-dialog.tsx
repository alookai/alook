"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const debouncedSave = useCallback((text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSaving(true)
      onSaveRef.current(text.trim())
      setTimeout(() => setSaving(false), 600)
    }, 800)
  }, [])

  useEffect(() => { return () => { if (timerRef.current) clearTimeout(timerRef.current) } }, [])

  const handleChange = (text: string) => {
    setValue(text)
    debouncedSave(text)
  }

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
              <Field label={<span>About Me {saving && <span className="ml-2 text-xs text-muted-foreground">Saving...</span>}</span>}>
                <Textarea className="h-24 resize-none" value={value} onChange={(e) => handleChange(e.target.value)} />
              </Field>
            </div>
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}
