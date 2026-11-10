"use client"

import type { ReactNode } from "react"
import { ListFilter } from "lucide-react"
import { AgentAvatar } from "@/components/avatar"
import { CreateTile } from "@/components/community/onboarding-tiles/create-tile"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BotSelectMenuContent, BotSelectMenuItem } from "./bot-select-menu"

export function BotPiiPanel({ bots, selectedId, onSelect, emptyAction, children }: {
  bots: readonly { id: string; name: string; image?: string | null }[]
  selectedId: string
  onSelect: (id: string) => void
  emptyAction?: ReactNode
  children: ReactNode
}) {
  const selected = bots.find(bot => bot.id === selectedId)
  return (
    <section className="@container flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4 thin-scrollbar sm:p-8" aria-labelledby="pii-heading">
      <header className="max-sm:sr-only">
        <h1 id="pii-heading" className="text-xl font-medium text-foreground">Privacy</h1>
      </header>
      <Tabs defaultValue="filters" className="flex-1 gap-8">
        <TabsList aria-label="Privacy tools" data-single-tab="switch" className="w-fit shrink-0 thin-scrollbar">
          <TabsTrigger value="filters" className="min-h-11 px-4"><ListFilter aria-hidden="true" className="size-4" />PII Filters</TabsTrigger>
        </TabsList>
        <TabsContent value="filters" className="flex w-full max-w-5xl flex-1 flex-col gap-8">
          <div className="flex max-w-2xl flex-col gap-2">
            <h2 className="text-lg font-medium">Filter outgoing messages</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">Filter sensitive information from messages your bot sends to Alook. Messages people send to your bot are not filtered. All filtering runs on your computer.</p>
          </div>
          {bots.length ? <div className="flex flex-col items-start gap-2 border-b border-border pb-8">
            <label id="pii-bot-label" className="text-sm font-medium">Bot</label>
            <div className="w-full sm:max-w-xs">
            <Select value={selectedId} onValueChange={value => { if (value) onSelect(value) }} items={bots.map(bot => ({ value: bot.id, label: bot.name }))}>
              <SelectTrigger aria-labelledby="pii-bot-label" data-testid="pii-bot-select" className="min-h-12 w-full px-4"><SelectValue>{selected ? <><AgentAvatar name={selected.name} avatarUrl={selected.image} seed={selected.id} size={32} className="size-8 [&_svg]:size-full!" alt="" /><span className="truncate text-base font-medium">{selected.name}</span></> : null}</SelectValue></SelectTrigger>
              <BotSelectMenuContent>{bots.map(bot => <BotSelectMenuItem key={bot.id} value={bot.id}><span className="flex min-w-0 items-center gap-2"><AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={24} className="size-6 [&_svg]:size-full!" alt="" /><span className="truncate">{bot.name}</span></span></BotSelectMenuItem>)}</BotSelectMenuContent>
            </Select>
            </div>
          </div> : null}
      {bots.length ? children : (
        // Same empty-state shape as My Bots and Machines: tile, title, text, action.
        <div data-slot="empty-state" className="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
          <div className="w-full max-w-70 overflow-hidden rounded-xl">
            <div className="aspect-200/130 w-full"><CreateTile /></div>
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">Create a bot first</h2>
            <p className="max-w-md text-sm text-muted-foreground">Filters belong to a bot. Create one in My Bots, then manage its filters here.</p>
          </div>
          {emptyAction}
        </div>
      )}
        </TabsContent>
      </Tabs>
    </section>
  )
}

export function BotPiiWorkspace({ action, reload, children, playground }: {
  action: ReactNode
  reload?: ReactNode
  children: ReactNode
  playground: ReactNode
}) {
  return <div className="grid min-w-0 gap-8 @min-4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="pii-filters-heading">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 id="pii-filters-heading" className="text-base font-medium">Filter pipeline</h3>
        <p className="text-sm text-muted-foreground">Enabled filters run in the order below.</p>
      </div>
      <div className="flex flex-col items-start gap-2">
        <div className="flex flex-wrap items-center gap-2">{action}{reload}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">Filters load from your computer. Our servers don’t store them.</p>
      </div>
      {children}
    </section>
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="pii-playground-heading">
      <div className="flex flex-col gap-2">
        <h3 id="pii-playground-heading" className="text-base font-medium">Test a message</h3>
        <p className="text-sm text-muted-foreground">Preview what your bot would send.</p>
      </div>
      {playground}
    </section>
  </div>
}
