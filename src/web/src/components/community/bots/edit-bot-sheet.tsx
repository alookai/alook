"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  type AvatarDraft,
  isPhotoAvatarUrl,
} from "@/components/avatar"
import { serializeBeamSeed, parseBeamSeed } from "@/lib/avatar/seed-url"
import { ProviderLogo } from "@/components/provider-logo"
import { useUpdateBot, useUploadBotAvatar, type BotSummary } from "@/hooks/community/use-bots"
import { useMachines } from "@/hooks/community/use-machines"
import { BotFormFields } from "./bot-form-fields"
import { ModelField } from "./model-field"
import { validateBotModel } from "./bot-form-validation"
import { uniqueNamesGenerator, names } from "unique-names-generator"
import { normalizeRuntimes } from "./create-bot-sheet"
import { cn } from "@/lib/utils"

function draftFromBot(bot: BotSummary): AvatarDraft {
  if (isPhotoAvatarUrl(bot.image)) return { kind: "photo", file: null, previewUrl: bot.image! }
  // A stored beam seed persists; a legacy `avatar:{shape…}` config or null
  // falls back to a beam seeded by the bot id.
  return { kind: "procedural", image: parseBeamSeed(bot.image) ? bot.image! : serializeBeamSeed(bot.id) }
}

export function EditBotSheet({
  bot,
  open,
  onOpenChange,
}: {
  // Nullable — the caller (`bot-list.tsx`) keeps this sheet mounted at all
  // times so the open/close transition always has a "closed" state to
  // animate from (mounting it fresh already-open, like the old
  // `{editing && <EditBotSheet .../>}` gate did, skips the enter animation
  // entirely). `bot` is only null before the first-ever edit.
  bot: BotSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(bot?.name ?? "")
  const [description, setDescription] = useState(bot?.description ?? "")
  const [model, setModel] = useState<string | null>(bot?.modelName ?? null)
  const [runtime, setRuntime] = useState(bot?.runtime ?? "")
  const [confirmProviderSwitch, setConfirmProviderSwitch] = useState(false)
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() =>
    bot ? draftFromBot(bot) : { kind: "procedural", image: serializeBeamSeed("initial") },
  )
  const update = useUpdateBot()
  const uploadBotAvatar = useUploadBotAvatar()
  const { machines } = useMachines()
  const selectedMachine = machines.find((machine) => machine.id === bot?.machineId)
  const runtimeOptions = useMemo(() => {
    const options = normalizeRuntimes(selectedMachine)
    if (runtime && !options.some((option) => option.id === runtime)) {
      options.push({ id: runtime, unhealthy: true })
    }
    return options
  }, [selectedMachine, runtime])

  // Re-sync the form fields from `bot` each time a *new* edit target opens
  // (keyed by id, not by every `bot` reference change — the parent's
  // `editingBot` never resets to null, so this only re-fires when the user
  // actually picks a different bot to edit).
  const syncedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !bot) return
    if (syncedForRef.current === bot.id) return
    syncedForRef.current = bot.id
    setName(bot.name)
    setDescription(bot.description ?? "")
    setModel(bot.modelName ?? null)
    setRuntime(bot.runtime)
    setAvatarDraft(draftFromBot(bot))
    setNameError(undefined)
    setConfirmProviderSwitch(false)
  }, [open, bot])

  function updateName(value: string) {
    setName(value)
    if (nameError && value.trim()) setNameError(undefined)
  }

  function shuffleName() {
    setName(uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" }))
    setNameError(undefined)
  }

  function selectRuntime(next: string) {
    if (next === runtime) return
    setRuntime(next)
    setModel(null)
  }

  async function performSubmit() {
    if (!bot) return
    if (!name.trim()) {
      setNameError("Name is required")
      return
    }
    const modelError = validateBotModel(model)
    if (modelError) {
      toast.error(modelError)
      return
    }
    const modelChanged = model !== (bot.modelName ?? null)
    const runtimeChanged = runtime !== bot.runtime
    try {
      // Sequence matters — only attempt the avatar upload AFTER the
      // name/description update resolves, inside the same try block, so a
      // failed field update never triggers an upload.
      await update.mutateAsync({
        id: bot.id,
        name: name.trim(),
        description: description.trim() || undefined,
        image: avatarDraft.kind === "procedural" ? avatarDraft.image : undefined,
        // Only send `model` when it actually changed, so an unrelated edit
        // never triggers a stop-and-rewake.
        ...(modelChanged ? { model } : {}),
        ...(runtimeChanged ? { runtime } : {}),
      })
      let avatarFailed = false
      if (avatarDraft.kind === "photo" && avatarDraft.file) {
        try {
          await uploadBotAvatar.mutateAsync({ botId: bot.id, file: avatarDraft.file })
        } catch (e) {
          avatarFailed = true
          toastApiError(e, "Bot updated, but the avatar photo failed to upload")
        }
      }
      if (!avatarFailed) {
        if (runtimeChanged) {
          toast.success(`Provider switch to ${runtime} dispatched`)
        } else if (modelChanged) {
          const label = model ?? "the runtime default"
          toast.success(`Model switch to ${label} dispatched`)
        } else {
          toast.success("Bot updated")
        }
      }
      onOpenChange(false)
    } catch (e) {
      toastApiError(e, "Update failed")
    }
  }

  function submit() {
    if (!bot) return
    if (!name.trim()) {
      setNameError("Name is required")
      return
    }
    if (runtime !== bot.runtime) {
      setConfirmProviderSwitch(true)
      return
    }
    void performSubmit()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <SheetContent
        side="right"
        showOverlay={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border data-[side=right]:sm:overflow-hidden"
      >
        <SheetHeader>
          <SheetTitle>Edit {bot?.name ?? "bot"}</SheetTitle>
          <SheetDescription>
            Name and description edits take effect on the next wake. Provider and model switches require the bot to be online.
          </SheetDescription>
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
            nameError={nameError}
          />
          {bot && (
            <>
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">Runtime</Label>
                {runtimeOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    This machine has no runtimes installed.
                  </p>
                ) : (
                  <div
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-label="Runtime"
                    data-testid="bot-provider-picker"
                  >
                    {runtimeOptions.map((option) => {
                      const selected = runtime === option.id
                      const disabled = option.unhealthy && !selected
                      return (
                        <label
                          key={option.id}
                          className={cn(
                            "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                            selected ? "border-primary bg-primary/5" : "border-border/50 hover:border-foreground/20",
                            disabled && "opacity-40 pointer-events-none",
                          )}
                        >
                          <input
                            type="radio"
                            name="edit-bot-runtime"
                            value={option.id}
                            checked={selected}
                            disabled={disabled}
                            onChange={() => selectRuntime(option.id)}
                            className="accent-primary size-3.5"
                          />
                          <ProviderLogo provider={option.id} className="size-4 shrink-0" />
                          <span className="text-sm">{option.id}</span>
                          {option.unhealthy && (
                            <span className="ml-auto text-xs text-muted-foreground">unavailable</span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <ModelField runtime={runtime} value={model} onChange={setModel} />
            </>
          )}
        </SheetBody>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending || !bot}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
      <AlertDialog open={confirmProviderSwitch} onOpenChange={setConfirmProviderSwitch}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch provider and reset this session?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching from {bot?.runtime} to {runtime} starts a fresh session. The bot cannot resume its current provider session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmProviderSwitch(false)
                void performSubmit()
              }}
            >
              Switch provider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
