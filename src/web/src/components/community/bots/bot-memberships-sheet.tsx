"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Loader2, Lock, LogOut } from "lucide-react"
import { AgentAvatar } from "@/components/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { CommunitySheet } from "../shell/community-sheet"
import { ServerIcon } from "../server-icon"
import { EntityIcon } from "../entity-icon"
import { avatarInitial } from "@/lib/community/avatar"
import { tid } from "@/lib/community/testids"
import { useBotMemberships, type BotMembershipTarget } from "@/hooks/community/use-bot-memberships"

export function BotMembershipsSheet({ bot, open, onOpenChange }: {
  bot: { id: string; name: string; image?: string | null }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const memberships = useBotMemberships(bot.id, open)
  const [target, setTarget] = useAtom(useCreateAtom<BotMembershipTarget | null>(null))
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))
  const select = (next: BotMembershipTarget) => { setError(null); setTarget(next) }
  const confirm = async () => {
    if (!target || memberships.pending) return
    const assert = memberships.capture()
    try {
      if (await memberships.leave(target)) { assert(); setTarget(null); setError(null) }
    } catch (cause) {
      try { assert() } catch { return }
      setError(cause instanceof Error ? cause.message : "Could not leave. Try again.")
    }
  }
  return <>
    <CommunitySheet open={open} onOpenChange={(next) => { if (!next) setTarget(null); onOpenChange(next) }} title="Servers & channels" description={<span className="flex min-w-0 items-center gap-2"><AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={24} /><span className="min-w-0 truncate" title={bot.name}>{bot.name}</span></span>} contentTestId={tid.botMembershipsSheet}>
      {memberships.isPending ? <div className="space-y-6" aria-label="Loading servers and channels" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="space-y-3"><Skeleton className="h-4 w-36" /><Skeleton className="ml-6 h-9 w-3/4" /><Skeleton className="ml-6 h-9 w-2/3" /></div>)}</div>
        : memberships.isError ? <div className="space-y-3 py-6"><p role="alert" className="text-sm text-muted-foreground">Could not load servers and channels.</p><Button variant="outline" disabled={memberships.isFetching} onClick={() => void memberships.refetch()}>Try again</Button></div>
        : memberships.data?.servers.length === 0 ? <div className="py-8"><p className="font-medium">No servers yet</p><p className="mt-1 text-sm text-muted-foreground">{bot.name} hasn&apos;t joined any servers.</p></div>
        : <div className="space-y-6">{memberships.data?.servers.map((server) => <section key={server.id} data-testid={tid.botMembershipsServer(server.id)}>
          <div className="flex min-h-11 items-center gap-2">
            <ServerIcon id={server.id} name={server.name} initial={avatarInitial(server.name)} icon={server.icon} size={16} className="shrink-0 rounded-sm" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={server.name}>{server.name}</h3>
            <Button variant="ghost" size="icon" className="size-11 shrink-0 text-muted-foreground hover:text-destructive" disabled={memberships.pending || !server.canLeave} aria-label={`Leave ${server.name}`} title={server.canLeave ? "Leave server" : "The server owner cannot leave"} data-testid={tid.botMembershipsLeave(server.id)} onClick={() => select({ kind: "server", id: server.id, ref: server.handle, name: server.name })}><LogOut className="size-4" aria-hidden="true" /></Button>
          </div>
          {server.channels.length === 0 ? <p className="py-3 pl-6 text-sm text-muted-foreground">No channels available</p> : server.channels.map((channel) => <div key={channel.id} data-testid={tid.botMembershipsChannel(channel.id)} className="flex min-h-11 items-center gap-2 rounded-md">
            <span className="flex w-4 shrink-0 justify-center">{channel.canLeave && <Lock className="size-3 text-muted-foreground" aria-label="Private channel" />}</span>
            <EntityIcon kind={channel.type} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm" title={channel.name}>{channel.name}</span>
            <Button variant="ghost" size="icon" className="size-11 shrink-0 text-muted-foreground hover:text-destructive" disabled={memberships.pending || (!channel.canLeave && !server.canLeave)} aria-label={`Leave ${channel.name}`} title={!channel.canLeave && !server.canLeave ? "The server owner cannot leave" : "Leave channel"} data-testid={tid.botMembershipsLeave(channel.id)} onClick={() => select(channel.canLeave ? { kind: "channel", id: channel.id, ref: channel.id, name: channel.name, serverName: server.name } : { kind: "server", id: server.id, ref: server.handle, name: server.name, publicChannelName: channel.name })}><LogOut className="size-4" aria-hidden="true" /></Button>
          </div>)}
        </section>)}</div>}
    </CommunitySheet>
    <AlertDialog open={open && target !== null} onOpenChange={(next) => { if (!next && !memberships.pending) setTarget(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-break-word">Remove {bot.name} from {target?.publicChannelName ?? target?.name}{target?.publicChannelName ? ` in ${target.name}` : target?.kind === "channel" ? ` in ${target.serverName}` : ""}?</AlertDialogTitle>
          <AlertDialogDescription>{target?.publicChannelName ? `This is a public channel. To leave it, this bot must leave ${target.name} and all its channels and threads.` : target?.kind === "server" ? "This bot will leave the server and all its channels and threads." : "This bot will leave the channel and its threads, and lose access to them."} Its past messages will remain.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-0" disabled={memberships.pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid={tid.botMembershipsConfirm} disabled={memberships.pending} onClick={() => void confirm()} className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:min-h-0">{memberships.pending && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}{memberships.pending ? "Leaving…" : target?.kind === "server" ? "Leave server" : "Leave channel"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
