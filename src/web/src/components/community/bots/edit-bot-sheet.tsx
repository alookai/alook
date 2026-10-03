"use client"

import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"

import { useEffect, useMemo } from "react"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
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
import { useUpdateBot, useUploadBotAvatar, type BotSummary } from "@/hooks/community/use-bots"
import { useMachines } from "@/hooks/community/use-machines"
import { BotFormFields } from "./bot-form-fields"
import { BotRuntimeFields } from "./bot-runtime-fields"
import { validateBotModel } from "./bot-form-validation"
import { uniqueNamesGenerator, names } from "unique-names-generator"
import { normalizeRuntimes } from "./create-bot-sheet"
import type { ReasoningEffort } from "@alook/shared"

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
  const source = useCommunityViewSource("edit-bot:" + (bot?.id ?? "none"), open && !!bot)
  const client = useQueryClient()
  const handleOpenChange = (next: boolean) => { if (!next) source.retire(); onOpenChange(next) }
  const [name, setName] = useAtom(useCreateAtom(bot?.name ?? ""))
  const [description, setDescription] = useAtom(useCreateAtom(bot?.description ?? ""))
  const [model, setModel] = useAtom(useCreateAtom<string | null>(bot?.modelName ?? null))
  const [reasoningEffort, setReasoningEffort] = useAtom(useCreateAtom<ReasoningEffort | null>(bot?.reasoningEffort ?? null))
  const [runtime, setRuntime] = useAtom(useCreateAtom(bot?.runtime ?? ""))
  const [confirmProviderSwitch, setConfirmProviderSwitch] = useAtom(useCreateAtom(false))
  const [nameError, setNameError] = useAtom(useCreateAtom<string | undefined>(undefined))
const [avatarDraft, setAvatarDraft] = useAtom(useCreateAtom<AvatarDraft>(((): AvatarDraft =>
    bot ? draftFromBot(bot) : { kind: "procedural", image: serializeBeamSeed("initial") })()))
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
  const initialization = useMemo(() => ({ scope: [source.signal], store: createStore(false) }), [source.signal]).store
  useEffect(() => {
    if (!open || !bot) return
    if (initialization.get()) return
    initialization.setState(() => true)
    setName(bot.name)
    setDescription(bot.description ?? "")
    setModel(bot.modelName ?? null)
    setReasoningEffort(bot.reasoningEffort ?? null)
    setRuntime(bot.runtime)
    setAvatarDraft(draftFromBot(bot))
    setNameError(undefined)
    setConfirmProviderSwitch(false)
  }, [open, bot, initialization, setName, setDescription, setModel, setReasoningEffort, setRuntime, setAvatarDraft, setNameError, setConfirmProviderSwitch])

  function updateName(value: string) {
    setName(value)
    if (nameError && value.trim()) setNameError(undefined)
  }

  function shuffleName() {
    setName(uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" }))
    setNameError(undefined)
  }

  async function performSubmit() {
    if (!bot || ["update-command", "avatar-command"].some((kind) => client.isMutating({ mutationKey: [...communityKeys.bots(), kind], exact: true, predicate: (mutation) => (mutation.state.variables as { input?: { assertActive?: { signal: AbortSignal } } }).input?.assertActive?.signal === source.signal }) > 0)) return
    const assert = source.capture()
    assert()
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
    const reasoningEffortChanged = reasoningEffort !== (bot.reasoningEffort ?? null)
    try {
      // Sequence matters — only attempt the avatar upload AFTER the
      // name/description update resolves, inside the same try block, so a
      // failed field update never triggers an upload.
      const result = await update.mutateAsync({
        assertActive: assert,
        id: bot.id,
        name: name.trim(),
        description: description.trim(),
        image: avatarDraft.kind === "procedural" ? avatarDraft.image : undefined,
        // Only send `model` when it actually changed, so an unrelated edit
        // never triggers a stop-and-rewake.
        ...(modelChanged ? { model } : {}),
        ...(runtimeChanged ? { runtime } : {}),
        ...(reasoningEffortChanged ? { reasoningEffort } : {}),
      })
      assert()
      let avatarFailed = false
      if (avatarDraft.kind === "photo" && avatarDraft.file) {
        try {
          await uploadBotAvatar.mutateAsync({ botId: bot.id, file: avatarDraft.file, assertActive: assert })
          assert()
        } catch (e) {
          try { assert() } catch { return }
          if (isAbortError(e)) return
          avatarFailed = true
          toastApiError(e, "Bot updated, but the avatar photo failed to upload", assert)
        }
      }
      if (!avatarFailed) {
        if ((runtimeChanged || modelChanged) && result.application === "saved_not_applied") {
          toast.success("Runtime settings saved for next start.")
        } else if (runtimeChanged) {
          toast.success(`Provider switch to ${runtime} dispatched`)
        } else if (modelChanged) {
          const label = model ?? "the runtime default"
          toast.success(`Model switch to ${label} dispatched`)
        } else if (reasoningEffortChanged) {
          toast.success(
            result.application === "next_turn"
              ? "Reasoning effort saved. Next turn takes effect."
              : "Reasoning effort saved for next start.",
          )
        } else {
          toast.success("Bot updated")
        }
      }
      assert()
      handleOpenChange(false)
    } catch (e) {
      if (isAbortError(e)) return
      toastApiError(e, "Update failed", assert)
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
    <>
      <CommunitySheet
        open={open}
        onOpenChange={handleOpenChange}
        title={`Edit ${bot?.name ?? "bot"}`}
        description="Name and description edits take effect on the next wake. Reasoning effort applies on the next turn when online, or the next start when offline. Provider and model switches require the bot to be online."
        bodyClassName="flex flex-col gap-6"
        footer={(requestClose) => (
          <>
            <Button variant="outline" onClick={requestClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={update.isPending || uploadBotAvatar.isPending || !bot}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      >
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
            <BotRuntimeFields
              options={runtimeOptions}
              runtime={runtime}
              model={model}
              daemonVersion={selectedMachine?.daemonVersion}
              reasoningEffort={reasoningEffort}
              onRuntimeChange={setRuntime}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
          )}
      </CommunitySheet>
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
    </>
  )
}
