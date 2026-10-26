"use client"

import { useEffect } from "react"
import { RefreshCw } from "lucide-react"
import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { isPresenceOnline } from "@alook/shared"
import { useBots } from "@/hooks/community/use-bots"
import { useMachines } from "@/hooks/community/use-machines"
import { useBotPii } from "@/hooks/community/use-bot-pii"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { BotPiiPanel } from "./bot-pii-panel"
import { BotPiiList } from "./bot-pii-list"
import { BotPiiChatAction } from "./bot-pii-chat-action"
import { BotPiiPlayground } from "./bot-pii-playground"

function BotPipeline({ botId, botName, machineId, online }: { botId: string; botName: string; machineId: string; online: boolean }) {
  const pii = useBotPii(botId, machineId, online)
  const [input, setInput] = useAtom(useCreateAtom(""))
  const active = useConversationActivity()
  const { clearPreview } = pii
  useEffect(() => { if (!active) { setInput(""); clearPreview() } }, [active, setInput, clearPreview])
  return (
    <>
      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="pii-filters-heading">
        <div className="flex flex-col">
        <div className="flex items-center gap-2">
            <h3 id="pii-filters-heading" className="text-base font-medium">PII steps</h3>
            <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label="Reload filters" aria-busy={pii.pending && !pii.previewPending} title="Reload filters" disabled={pii.pending || !online} onClick={() => { void pii.reload() }}><RefreshCw aria-hidden="true" className={pii.pending && !pii.previewPending ? "animate-spin motion-reduce:animate-none" : undefined} /></Button>
        </div>
        <BotPiiChatAction botId={botId} />
        </div>
        {pii.snapshot ? <BotPiiList botName={botName} plugins={pii.snapshot.plugins} pending={pii.pending} error={pii.error} unavailable={pii.unavailable}
          onSetEnabled={(id, enabled) => { void pii.setEnabled(id, enabled) }} onDelete={pii.remove} />
          : pii.unavailable || pii.error ? <p role={pii.error ? "alert" : "status"} className="text-sm text-muted-foreground">{pii.unavailable ?? pii.error}</p>
          : <div role="status" aria-label="Loading filters" className="flex flex-col gap-4">{[0, 1, 2].map(id => <Skeleton key={id} className="h-20 w-full rounded-md" />)}</div>}
      </section>
      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="pii-playground-heading">
      <h3 id="pii-playground-heading" className="text-base font-medium">Playground</h3>
      <BotPiiPlayground value={input} onValueChange={value => { setInput(value); pii.clearPreview() }}
        result={pii.output} triggeredFilters={pii.triggeredFilters} pending={pii.previewPending} error={pii.previewError ?? pii.unavailable}
        disabled={pii.pending || !pii.snapshot || Boolean(pii.unavailable)} onRun={() => { void pii.preview(input) }} />
      </section>
    </>
  )
}

export function BotPiiView() {
  const owner = useCommunityWsStore(state => `${state.profileViewerId}:${state.profileAccountEpoch}`)
  const bots = useBots()
  const machines = useMachines()
  const [chosenId, setChosenId] = useAtom(useCreateAtom(""))
  const selected = bots.bots.find(bot => bot.id === chosenId) ?? bots.bots[0]
  if (bots.isPending || bots.profilesPending) return <div role="status" aria-label="Loading bots" className="p-6"><Skeleton className="h-8 w-48" /></div>
  if (bots.isError && !bots.data) return <div role="alert" className="flex flex-col items-start gap-3 p-6"><p>Could not load your bots.</p><Button variant="outline" className="min-h-11" onClick={() => { void bots.refetch() }}>Retry</Button></div>
  const machine = machines.machines.find(item => item.id === selected?.machineId)
  return (
    <BotPiiPanel bots={bots.bots} selectedId={selected?.id ?? ""} onSelect={setChosenId}>
      {selected && machines.isPending ? <Skeleton className="h-20 w-full" />
        : selected && machine?.status === undefined ? <div role="status" className="flex flex-col items-start gap-3"><p className="text-sm text-muted-foreground">Could not confirm this machine’s status.</p><Button variant="outline" className="min-h-11" onClick={() => { void machines.refetch() }}>Retry</Button></div>
        : selected ? <BotPipeline key={`${owner}:${selected.id}:${selected.machineId}`} botId={selected.id} botName={selected.name} machineId={selected.machineId} online={isPresenceOnline(machine?.status)} /> : null}
    </BotPiiPanel>
  )
}
