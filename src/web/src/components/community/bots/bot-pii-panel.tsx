"use client"

import type { ReactNode } from "react"
import { AgentAvatar } from "@/components/avatar"
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BotSelectMenuContent, BotSelectMenuItem } from "./bot-select-menu"

export function BotPiiPanel({ bots, selectedId, onSelect, children }: {
  bots: readonly { id: string; name: string; image?: string | null }[]
  selectedId: string
  onSelect: (id: string) => void
  children: ReactNode
}) {
  const selected = bots.find(bot => bot.id === selectedId)
  return (
    <section className="@container flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4 sm:p-8 thin-scrollbar" aria-labelledby="pii-heading">
      <header className="flex flex-col gap-2">
        <h1 id="pii-heading" className="text-2xl font-medium">Privacy</h1>
        <p className="max-w-prose text-base leading-relaxed text-muted-foreground">Your message passes through each enabled filter before it reaches Alook.</p>
        <p className="max-w-prose text-sm text-muted-foreground">Runs on your machine. Message text only; attachments and AI model requests are excluded.</p>
      </header>
      {bots.length ? (
        <>
          <div className="flex max-w-sm flex-col gap-2">
            <label id="pii-bot-label" className="text-sm font-medium">Bot</label>
            <Select value={selectedId} onValueChange={value => { if (value) onSelect(value) }} items={bots.map(bot => ({ value: bot.id, label: bot.name }))}>
              <SelectTrigger aria-labelledby="pii-bot-label" data-testid="pii-bot-select" className="min-h-12 w-full border-0 px-0 shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent"><SelectValue>{selected ? <><AgentAvatar name={selected.name} avatarUrl={selected.image} seed={selected.id} size={32} className="size-8 [&_svg]:size-full!" alt="" /><span className="truncate text-base font-medium">{selected.name}</span></> : null}</SelectValue></SelectTrigger>
              <BotSelectMenuContent>{bots.map(bot => <BotSelectMenuItem key={bot.id} value={bot.id}><span className="flex min-w-0 items-center gap-2"><AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={24} className="size-6 [&_svg]:size-full!" alt="" /><span className="truncate">{bot.name}</span></span></BotSelectMenuItem>)}</BotSelectMenuContent>
            </Select>
            <p className="text-xs text-muted-foreground">Changes apply only to this bot.</p>
          </div>
          {children}
        </>
      ) : (
        <div className="py-8">
          <h2 className="font-medium">Create a bot first</h2>
          <p className="mt-1 text-sm text-muted-foreground">Open My Bots to create a bot, then manage its filters here.</p>
        </div>
      )}
    </section>
  )
}
