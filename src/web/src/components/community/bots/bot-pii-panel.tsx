"use client"

import type { ReactNode } from "react"
import { AgentAvatar } from "@/components/avatar"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
    <section className="@container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 thin-scrollbar" aria-labelledby="pii-heading">
      <header className="flex flex-col items-start gap-2">
        <h1 id="pii-heading" className="text-xl font-medium text-foreground">Privacy</h1>
      </header>
      <Tabs defaultValue="filters" className="gap-6">
        <TabsList variant="line" aria-label="Privacy tools" className="h-auto min-h-12 w-full border-b p-0 thin-scrollbar">
          <TabsTrigger value="filters" className="min-h-12 px-4 text-base group-data-horizontal/tabs:after:bottom-0">PII Filters</TabsTrigger>
        </TabsList>
        <TabsContent value="filters" className="mx-auto flex w-full max-w-2xl flex-col gap-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Filters for bot message</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">Filter sensitive information from messages your bot sends to Alook. Messages people send to your bot are not filtered. All filtering runs on your computer.</p>
          </div>
          {bots.length ? <section className="flex flex-col gap-4" aria-labelledby="pii-bot-section-heading">
            <h3 id="pii-bot-section-heading" className="text-base font-medium">Which bot to set up</h3>
            <div className="w-full sm:max-w-xs">
            <label id="pii-bot-label" className="sr-only">Bot</label>
            <Select value={selectedId} onValueChange={value => { if (value) onSelect(value) }} items={bots.map(bot => ({ value: bot.id, label: bot.name }))}>
              <SelectTrigger aria-labelledby="pii-bot-label" data-testid="pii-bot-select" className="min-h-11 w-full border-0 px-2 shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent"><SelectValue>{selected ? <><AgentAvatar name={selected.name} avatarUrl={selected.image} seed={selected.id} size={32} className="size-8 [&_svg]:size-full!" alt="" /><span className="truncate text-base font-medium">{selected.name}</span></> : null}</SelectValue></SelectTrigger>
              <BotSelectMenuContent>{bots.map(bot => <BotSelectMenuItem key={bot.id} value={bot.id}><span className="flex min-w-0 items-center gap-2"><AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={24} className="size-6 [&_svg]:size-full!" alt="" /><span className="truncate">{bot.name}</span></span></BotSelectMenuItem>)}</BotSelectMenuContent>
            </Select>
            </div>
          </section> : null}
      {bots.length ? children : (
        <div className="py-8">
          <h2 className="font-medium">Create a bot first</h2>
          <p className="mt-1 text-sm text-muted-foreground">Open My Bots to create a bot, then manage its filters here.</p>
        </div>
      )}
        </TabsContent>
      </Tabs>
    </section>
  )
}
