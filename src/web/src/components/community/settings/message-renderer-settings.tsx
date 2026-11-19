"use client"

import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { messageRendererAvailable, selectMessageRenderer, useMessageRendererSettings } from "../messages/renderers/message-renderer-settings"
import type { MessageRendererId } from "../messages/renderers/message-cell-types"

const choices: { id: MessageRendererId; label: string }[] = [{ id: "current", label: "Current" }, { id: "chatscope", label: "Chatscope" }, { id: "lobe", label: "Lobe UI" }]
export function MessageRendererSettings({ accountId }: { accountId?: string | null }) {
  const settings = useMessageRendererSettings(accountId)
  return (
    <section className="space-y-2 pb-8" aria-labelledby="message-renderer-heading">
      <h2 id="message-renderer-heading" className="text-base font-medium tracking-tight">Message renderer</h2>
      <p className="text-sm leading-6 text-muted-foreground">Choose how messages look. Saved for this account on this device.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={settings.id} disabled={!accountId || !settings.ready || !!settings.pending} onValueChange={(value) => { if (accountId && value) void selectMessageRenderer(accountId, value) }}>
          <SelectTrigger aria-label="Message renderer" data-testid={tid.settingsMessageRenderer}><SelectValue>{choices.find(choice => choice.id === settings.id)?.label}</SelectValue></SelectTrigger>
          <SelectContent>{choices.map(choice => <SelectItem key={choice.id} value={choice.id} disabled={!messageRendererAvailable(choice.id)}>{choice.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={!accountId} onClick={() => { if (accountId) void selectMessageRenderer(accountId, "current") }}>Return to Current</Button>
      </div>
      {(!settings.ready || settings.pending) && <p role="status" className="text-sm text-muted-foreground">Loading message renderer…</p>}
      {settings.error && <p role="alert" className="text-sm text-destructive">{settings.error}</p>}
      {!settings.storageAvailable && !settings.error && <p role="status" className="text-sm text-muted-foreground">Local storage is unavailable. Current is active.</p>}
    </section>
  )
}
