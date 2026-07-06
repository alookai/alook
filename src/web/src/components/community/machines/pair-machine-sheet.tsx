"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Copy, Loader2 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/lib/api/client"
import { COMMUNITY_SERVER_URL, COMMUNITY_DAEMON_WS_URL } from "@/lib/community/env"

export type PairMachineSheetMode =
  | { kind: "pair" }
  | { kind: "reconnect"; machineId: string; hostname: string }

export function PairMachineSheet({
  open,
  onOpenChange,
  pendingTokenId,
  setPendingTokenId,
  connectedHostname,
  mode = { kind: "pair" },
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingTokenId: string | null
  setPendingTokenId: (tokenId: string | null) => void
  connectedHostname: string | null
  mode?: PairMachineSheetMode
}) {
  const isReconnect = mode.kind === "reconnect"
  const [generating, setGenerating] = useState(false)
  const generatedForKey = useRef<string | null>(null)

  const generate = useCallback(async () => {
    setGenerating(true)
    try {
      const endpoint =
        mode.kind === "reconnect"
          ? `/api/community/machines/${mode.machineId}/reconnect`
          : "/api/community/machines/pair"
      const res = await apiFetch<{ tokenId: string; expiresAt: string }>(
        endpoint,
        { method: "POST" }
      )
      setPendingTokenId(res.tokenId)
    } catch (err) {
      toast.error("Couldn't generate a key — try again.")
      console.error(err)
    } finally {
      setGenerating(false)
    }
  }, [setPendingTokenId, mode])

  // Auto-generate the key when the sheet opens. Track per-open so re-opens or
  // mode swaps trigger a fresh mint.
  const openKey = open
    ? mode.kind === "reconnect"
      ? `reconnect:${mode.machineId}`
      : "pair"
    : null
  useEffect(() => {
    if (!openKey) {
      generatedForKey.current = null
      return
    }
    if (generatedForKey.current === openKey) return
    generatedForKey.current = openKey
    setPendingTokenId(null)
    void generate()
  }, [openKey, generate, setPendingTokenId])

  const command = pendingTokenId
    ? `npx @alook/daemon daemon start --machine-key ${pendingTokenId} --server-url ${COMMUNITY_SERVER_URL} --ws-url ${COMMUNITY_DAEMON_WS_URL}`
    : ""

  const copyCommand = useCallback(async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Command copied")
    } catch {
      toast.error("Copy failed")
    }
  }, [command])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>
            {isReconnect ? `Reconnect ${mode.hostname || "machine"}` : "Connect a machine"}
          </SheetTitle>
          <SheetDescription>
            {isReconnect
              ? "We rotated the key. Run the new command on your machine — the old one is no longer accepted."
              : "Run this on the computer you want to connect. The key is good for 15 minutes."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-6">
          <Step1
            command={command}
            generating={generating || !command}
            onCopy={copyCommand}
          />
          <Step2 ready={!!command} connectedHostname={connectedHostname} />
        </SheetBody>
        <SheetFooter>
          <SheetClose render={<Button variant="secondary">Done</Button>} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Step1({
  command,
  generating,
  onCopy,
}: {
  command: string
  generating: boolean
  onCopy: () => void
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Marker n={1} done={!generating} />
        <h3 className="text-sm font-medium text-foreground">Run this on your machine</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        Open a terminal on the computer you want to connect, paste the command,
        and hit enter. Node 20+ is the only prerequisite.
      </p>
      {generating ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Preparing your command…
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
          <code className="flex-1 break-all">{command}</code>
          <button
            onClick={onCopy}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Copy command"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      )}
    </section>
  )
}

function Step2({
  ready,
  connectedHostname,
}: {
  ready: boolean
  connectedHostname: string | null
}) {
  if (connectedHostname) {
    return (
      <section className="flex flex-col gap-3">
        <header className="flex items-center gap-2">
          <Marker n={2} done />
          <h3 className="text-sm font-medium text-foreground">Connected</h3>
        </header>
        <div className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-foreground">{connectedHostname}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
              Online
            </span>
          </span>
          <span className="text-muted-foreground">is ready for your agent friends.</span>
        </div>
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Marker n={2} muted={!ready} spinning={ready} />
        <h3
          className={[
            "text-sm font-medium",
            ready ? "text-foreground" : "text-muted-foreground",
          ].join(" ")}
        >
          Waiting for the daemon…
        </h3>
      </header>
    </section>
  )
}

function Marker({
  n,
  muted,
  done,
  spinning,
}: {
  n: number
  muted?: boolean
  done?: boolean
  spinning?: boolean
}) {
  return (
    <span
      className={[
        "relative grid size-6 place-items-center rounded-full text-xs font-medium",
        done
          ? "bg-emerald-500 text-white"
          : muted
            ? "bg-muted text-muted-foreground"
            : "bg-primary text-primary-foreground",
      ].join(" ")}
    >
      {spinning && (
        <span className="absolute inset-[-3px] rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      )}
      {n}
    </span>
  )
}
