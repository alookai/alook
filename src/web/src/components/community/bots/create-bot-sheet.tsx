"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { isPresenceOnline } from "@alook/shared"
import { machineName } from "@/lib/community/machine-name"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  type AvatarConfig,
  type AvatarDraft,
  randomConfig,
  serializeAvatarConfig,
} from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCreateBot, useUploadBotAvatar } from "@/hooks/community/use-bots"
import { BotFormFields } from "./bot-form-fields"
import {
  type BotCreateFieldErrors,
  hasBotCreateFieldErrors,
  validateBotCreateFields,
} from "./bot-form-validation"
import { uniqueNamesGenerator, names } from "unique-names-generator"
import { cn } from "@/lib/utils"

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

export function CreateBotSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { machines } = useMachines()
  const create = useCreateBot()
  const uploadBotAvatar = useUploadBotAvatar()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [machineId, setMachineId] = useState<string>("")
  const [runtime, setRuntime] = useState<string>("")
  const [fieldErrors, setFieldErrors] = useState<BotCreateFieldErrors>({})
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>({
    kind: "procedural",
    image: serializeAvatarConfig(INITIAL_AVATAR),
  })

  const selectedMachine = machines.find((m) => m.id === machineId)
  const runtimeOptions = useMemo(() => {
    // Nullish guard — a legacy CommunityMachineSummary cached client-side may
    // still be missing availableRuntimes, or a runtime entry may still be a
    // bare string (pre-health-status shape). Normalize both into
    // `{ id, unhealthy }` instead of hiding unhealthy runtimes outright, so
    // the radio card can show *why* an option is disabled.
    const rt = selectedMachine?.availableRuntimes ?? []
    const normalized = rt.map((r) =>
      typeof r === "string"
        ? { id: r, unhealthy: false }
        : { id: (r as { id: string }).id, unhealthy: (r as { status?: string }).status === "unhealthy" },
    )
    // Available runtimes sort first — the ones you can actually pick should
    // never be buried below ones you can't.
    return normalized.sort((a, b) => Number(a.unhealthy) - Number(b.unhealthy))
  }, [selectedMachine])

  // Randomize name + avatar on client mount (not during SSR — Math.random would
  // hydration-mismatch). Fires once per sheet open.
  const initializedFor = useRef<boolean | null>(null)
  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    if (initializedFor.current) return
    initializedFor.current = true
    setName(randomBotName())
    setAvatarDraft({ kind: "procedural", image: serializeAvatarConfig(randomConfig()) })
    setDescription("")
    setMachineId("")
    setRuntime("")
    setFieldErrors({})
  }, [open])

  function shuffleName() {
    setName(randomBotName())
    setFieldErrors((prev) => ({ ...prev, name: undefined }))
  }

  function updateName(value: string) {
    setName(value)
    if (fieldErrors.name && value.trim()) {
      setFieldErrors((prev) => ({ ...prev, name: undefined }))
    }
  }

  function selectMachine(id: string) {
    setMachineId(id)
    setRuntime("")
    setFieldErrors((prev) => ({ ...prev, machineId: undefined }))
  }

  function selectRuntime(id: string) {
    setRuntime(id)
    setFieldErrors((prev) => ({ ...prev, runtime: undefined }))
  }

  async function submit() {
    const nextErrors = validateBotCreateFields({ name, machineId, runtime })
    setFieldErrors(nextErrors)
    if (hasBotCreateFieldErrors(nextErrors)) return

    try {
      const data = await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        machineId,
        runtime,
        image: avatarDraft.kind === "procedural" ? avatarDraft.image : undefined,
      })
      // Bots don't have an id until creation resolves — the photo upload is
      // deferred until now so a cropped-then-cancelled dialog never uploads
      // anything. Surface an upload failure without blocking on it; the bot
      // itself was already created successfully.
      let avatarFailed = false
      if (avatarDraft.kind === "photo" && avatarDraft.file) {
        try {
          await uploadBotAvatar.mutateAsync({ botId: data.bot.id, file: avatarDraft.file })
        } catch (e) {
          avatarFailed = true
          toastApiError(e, "Bot created, but the avatar photo failed to upload")
        }
      }
      if (!avatarFailed) toast.success(`Created ${name.trim()}`)
      onOpenChange(false)
    } catch (e) {
      toastApiError(e, "Couldn't create the bot")
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <SheetContent
        side="right"
        showOverlay={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border data-[side=right]:sm:overflow-hidden"
      >
        <SheetHeader>
          <SheetTitle>Create a bot</SheetTitle>
        </SheetHeader>

        <SheetBody className="flex flex-col gap-6">
          <BotFormFields
            avatarDraft={avatarDraft}
            onAvatarChange={setAvatarDraft}
            name={name}
            setName={updateName}
            onShuffle={shuffleName}
            description={description}
            setDescription={setDescription}
            nameError={fieldErrors.name}
          />

          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Machine</Label>
            {machines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No paired machines — pair one first.
              </p>
            ) : (
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Machine">
                {machines.map((m) => {
                  const online = isPresenceOnline(m.status)
                  const selected = machineId === m.id
                  return (
                    <label
                      key={m.id}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                        selected ? "border-primary bg-primary/5" : "border-border/50 hover:border-foreground/20",
                        !online && "opacity-40 pointer-events-none",
                      )}
                    >
                      <input
                        type="radio"
                        name="bot-machine"
                        value={m.id}
                        checked={selected}
                        disabled={!online}
                        onChange={() => selectMachine(m.id)}
                        className="accent-primary size-3.5"
                      />
                      <span className="text-sm">{machineName(m)}</span>
                      <span
                        className={cn(
                          "ml-auto inline-flex items-center gap-1 text-xs",
                          online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block size-1.5 rounded-full",
                            online ? "bg-status-online" : "bg-muted-foreground",
                          )}
                        />
                        {online ? "Online" : "Offline"}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {fieldErrors.machineId && (
              <p className="text-xs text-destructive">{fieldErrors.machineId}</p>
            )}
          </div>

          {selectedMachine && (
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">Runtime</Label>
              {runtimeOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  This machine has no runtimes installed.
                </p>
              ) : (
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Runtime">
                  {runtimeOptions.map((r) => {
                    const selected = runtime === r.id
                    return (
                      <label
                        key={r.id}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                          selected ? "border-primary bg-primary/5" : "border-border/50 hover:border-foreground/20",
                          r.unhealthy && "opacity-40 pointer-events-none",
                        )}
                      >
                        <input
                          type="radio"
                          name="bot-runtime"
                          value={r.id}
                          checked={selected}
                          disabled={r.unhealthy}
                          onChange={() => selectRuntime(r.id)}
                          className="accent-primary size-3.5"
                        />
                        <ProviderLogo provider={r.id} className="size-4 shrink-0" />
                        <span className="text-sm">{r.id}</span>
                        {r.unhealthy && (
                          <span className="ml-auto text-xs text-muted-foreground">unavailable</span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
              {fieldErrors.runtime && (
                <p className="text-xs text-destructive">{fieldErrors.runtime}</p>
              )}
            </div>
          )}
        </SheetBody>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create bot"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
