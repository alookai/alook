"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Dices } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  type AvatarConfig,
  AvatarPickerDialog,
  randomConfig,
  serializeAvatarConfig,
} from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCreateBot } from "@/hooks/community/use-bots"
import {
  COMMUNITY_BOT_NAME_MAX,
  COMMUNITY_BOT_DESCRIPTION_MAX,
} from "@alook/shared"
import { uniqueNamesGenerator, names } from "unique-names-generator"

// Stable initial config avoids hydration mismatch (randomConfig uses Math.random).
const INITIAL_AVATAR: AvatarConfig = {
  shape: "circle",
  eye: "dots",
  nose: "dot",
  bg: 0,
}

function randomBotName(): string {
  return uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" })
}

function machineLabel(m: {
  displayName?: string | null
  hostname?: string | null
  id: string
}): string {
  const name = m.displayName?.trim() || m.hostname?.trim()
  return name || "Unnamed machine"
}

export function CreateBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { machines } = useMachines()
  const create = useCreateBot()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [machineId, setMachineId] = useState<string>("")
  const [runtime, setRuntime] = useState<string>("")
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(INITIAL_AVATAR)

  const selectedMachine = machines.find((m) => m.id === machineId)
  const runtimeOptions = useMemo(() => {
    // Nullish guard — a legacy CommunityMachineSummary cached client-side may
    // still be missing availableRuntimes. `filter` on undefined would throw.
    const rt = selectedMachine?.availableRuntimes ?? []
    return rt
      // Only offer healthy runtimes for binding. The server-side /api/community/bots
      // POST validator ALSO enforces `status === 'healthy'` — this filter is UX
      // only. Older summaries that predate the widening default `status` to
      // "healthy" via Zod, so they still show through.
      .filter((r) => {
        if (typeof r === "string") return true
        return (r as { status?: string }).status !== "unhealthy"
      })
      .map((r) => (typeof r === "string" ? r : (r as { id: string }).id))
  }, [selectedMachine])

  // Randomize name + avatar on client mount (not during SSR — Math.random would
  // hydration-mismatch). Fires once per dialog open.
  const initializedFor = useRef<boolean | null>(null)
  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    if (initializedFor.current) return
    initializedFor.current = true
    setName(randomBotName())
    setAvatarConfig(randomConfig())
    setDescription("")
    setMachineId("")
    setRuntime("")
  }, [open])

  function shuffleName() {
    setName(randomBotName())
  }

  async function submit() {
    if (!name.trim()) return toast.error("Name is required")
    if (!machineId) return toast.error("Pick a machine")
    if (!runtime) return toast.error("Pick a runtime")
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        machineId,
        runtime,
        image: serializeAvatarConfig(avatarConfig) ?? undefined,
      })
      toast.success(`Created ${name.trim()}`)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the bot")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a bot</DialogTitle>
        </DialogHeader>

        {/* Single column. Every field is full-width. Rhythm: gap-4 between
            fields, gap-2 within a field (label + control). */}
        <div className="flex flex-col gap-4">
          {/* Centered avatar picker — the identity anchor. */}
          <div className="flex justify-center pt-1">
            <AvatarPickerDialog config={avatarConfig} onChange={setAvatarConfig} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="bot-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <div className="relative w-full">
              <Input
                id="bot-name"
                value={name}
                maxLength={COMMUNITY_BOT_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name your bot"
                autoFocus
                className="h-9 w-full pr-10"
              />
              <button
                type="button"
                onClick={shuffleName}
                aria-label="Randomize name"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Dices className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="bot-description" className="text-xs text-muted-foreground">
              Description
            </Label>
            <Textarea
              id="bot-description"
              value={description}
              maxLength={COMMUNITY_BOT_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this bot for?"
              rows={3}
              className="min-h-[72px] resize-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Machine</Label>
            <Select
              value={machineId}
              onValueChange={(v) => {
                setMachineId(v ?? "")
                setRuntime("")
              }}
            >
              <SelectTrigger className="h-9 w-full">
                {/*
                  base-ui's SelectValue renders the raw `value` string unless a
                  function-child is supplied. Look the id up and render the
                  human label so users don't see the machine id.
                */}
                <SelectValue placeholder="Select a machine">
                  {(v) => {
                    const m = machines.find((x) => x.id === v)
                    return m ? machineLabel(m) : "Select a machine"
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="p-1">
                {machines.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    No paired machines — pair one first.
                  </div>
                )}
                {machines.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="px-2 py-2">
                    {machineLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Runtime</Label>
            <Select
              value={runtime}
              onValueChange={(v) => setRuntime(v ?? "")}
              disabled={!selectedMachine}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue
                  placeholder={
                    selectedMachine ? "Select a runtime" : "Pick a machine first"
                  }
                >
                  {(v) =>
                    v ? (
                      <span className="flex items-center gap-2">
                        <ProviderLogo provider={v} className="size-4" />
                        <span>{v}</span>
                      </span>
                    ) : selectedMachine ? (
                      "Select a runtime"
                    ) : (
                      "Pick a machine first"
                    )
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="p-1">
                {runtimeOptions.length === 0 && selectedMachine && (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    {(selectedMachine.availableRuntimes ?? []).length === 0
                      ? "This machine has no runtimes installed."
                      : "No healthy runtimes available on this machine."}
                  </div>
                )}
                {runtimeOptions.map((r) => (
                  <SelectItem key={r} value={r} className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      <ProviderLogo provider={r} className="size-4 shrink-0" />
                      <span>{r}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
