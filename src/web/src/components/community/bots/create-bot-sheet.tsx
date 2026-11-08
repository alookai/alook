"use client"
import { BotMachineField } from "./bot-machine-field"
import { normalizeRuntimes, firstHealthyRuntimeId, type MachineSummary } from "@/lib/community/machines"

import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"

import { useEffect, useMemo } from "react"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import {
  isPresenceOnline,
  requiresExplicitModel,
  type ReasoningEffort,
} from "@alook/shared"


import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
import { type AvatarDraft } from "@/components/avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { useAvatarDraftPreview } from "@/lib/avatar/use-avatar-draft-preview"
import { randomBotName } from "@/lib/community/bot-random-name"

import { useMachines } from "@/hooks/community/use-machines"
import { useCreateBot, useUploadBotAvatar } from "@/hooks/community/use-bots"
import { BotFormFields } from "./bot-form-fields"
import { BotRuntimeFields } from "./bot-runtime-fields"
import {
  type BotCreateFieldErrors,
  hasBotCreateFieldErrors,
  validateBotCreateFields,
} from "./bot-form-validation"
import type { BotSummary } from "@/hooks/community/use-bots"

// Stable initial seed avoids hydration mismatch (real seed is rerolled on mount).
const INITIAL_AVATAR = serializeBeamSeed("initial")

/** First online (selectable) machine id, or "" if none. */
export function firstOnlineMachineId(machines: MachineSummary[]): string {
  return machines.find((m) => isPresenceOnline(m.status))?.id ?? ""
}

export function CreateBotSheet({
  open,
  onOpenChange,
  onCreated,
  avatarSeed,
  onAskBotToCreate,
  askingBotToCreate = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (bot: BotSummary) => void | Promise<void>
  avatarSeed?: string
  onAskBotToCreate?: () => void | Promise<void>
  askingBotToCreate?: boolean
}) {
  const source = useCommunityViewSource("create-bot", open)
  const client = useQueryClient()
  const handleOpenChange = (next: boolean) => { if (!next) source.retire(); onOpenChange(next) }
  const { machines } = useMachines()
  const create = useCreateBot()
  const uploadBotAvatar = useUploadBotAvatar()
  const [name, setName] = useAtom(useCreateAtom(""))
  const [description, setDescription] = useAtom(useCreateAtom(""))
  const [machineId, setMachineId] = useAtom(useCreateAtom<string>(""))
  const [runtime, setRuntime] = useAtom(useCreateAtom<string>(""))
  const [model, setModel] = useAtom(useCreateAtom<string | null>(null))
  const [reasoningEffort, setReasoningEffort] = useAtom(useCreateAtom<ReasoningEffort | null>(null))
  const [fieldErrors, setFieldErrors] = useAtom(useCreateAtom<BotCreateFieldErrors>({}))
  const [avatarDraft, setAvatarDraft] = useAtom(useCreateAtom<AvatarDraft>({
    kind: "procedural",
    image: INITIAL_AVATAR,
  }))
  useAvatarDraftPreview(avatarDraft)

  const selectedMachine = machines.find((m) => m.id === machineId)
  const runtimeOptions = useMemo(() => normalizeRuntimes(selectedMachine), [selectedMachine])
  // Randomize name + avatar on client mount (not during SSR — Math.random would
  // hydration-mismatch). Fires once per sheet open.
  const initialization = useMemo(() => ({ scope: [source.signal], store: createStore(false) }), [source.signal]).store
  useEffect(() => {
    if (!open || initialization.get()) return
    initialization.setState(() => true)
    setName(randomBotName())
    setAvatarDraft({
      kind: "procedural",
      image: serializeBeamSeed(avatarSeed ?? crypto.randomUUID()),
    })
    setDescription("")
    setMachineId("")
    setRuntime("")
    setModel(null)
    setReasoningEffort(null)
    setFieldErrors({})
  }, [open, avatarSeed, initialization, setName, setAvatarDraft, setDescription, setMachineId, setRuntime, setModel, setReasoningEffort, setFieldErrors])

  // Auto-select sensible defaults once machine data arrives. useMachines()
  // loads async, so `machines` is often [] on the open transition and
  // populates a tick later — this reacts to that. Each write is guarded on the
  // target being "" so a presence refetch never overwrites a made choice.
  useEffect(() => {
    if (!open) return
    if (machineId === "") {
      const next = firstOnlineMachineId(machines)
      if (next) setMachineId(next)
      return
    }
    if (runtime === "") {
      const next = firstHealthyRuntimeId(runtimeOptions)
      if (next) setRuntime(next)
    }
  }, [open, machines, runtimeOptions, machineId, runtime, setMachineId, setRuntime])

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
    const nextMachine = machines.find((m) => m.id === id)
    setRuntime(firstHealthyRuntimeId(normalizeRuntimes(nextMachine)))
    // A model id is runtime-specific; a machine switch can change the runtime,
    // so drop any selected model back to Default.
    setModel(null)
    setReasoningEffort(null)
    setFieldErrors((prev) => ({ ...prev, machineId: undefined, model: undefined }))
  }

  function selectRuntime(id: string) {
    setRuntime(id)
    setFieldErrors((prev) => ({ ...prev, runtime: undefined }))
  }

  async function submit() {
    if (["create-command", "avatar-command"].some((kind) => client.isMutating({ mutationKey: [...communityKeys.bots(), kind], exact: true, predicate: (mutation) => (mutation.state.variables as { input?: { assertActive?: { signal: AbortSignal } } }).input?.assertActive?.signal === source.signal }) > 0)) return
    const assert = source.capture()
    assert()
    const nextErrors = validateBotCreateFields({ name, machineId, runtime, model })
    setFieldErrors(nextErrors)
    if (hasBotCreateFieldErrors(nextErrors)) return

    try {
      const data = await create.mutateAsync({
        assertActive: assert,
        name: name.trim(),
        description: description.trim() || undefined,
        machineId,
        runtime,
        image: avatarDraft.kind === "procedural" ? avatarDraft.image : undefined,
        model,
        reasoningEffort,
      })
      assert()
      // Bots don't have an id until creation resolves — the photo upload is
      // deferred until now so a cropped-then-cancelled dialog never uploads
      // anything. Surface an upload failure without blocking on it; the bot
      // itself was already created successfully.
      let avatarFailed = false
      if (avatarDraft.kind === "photo" && avatarDraft.file) {
        try {
          await uploadBotAvatar.mutateAsync({ botId: data.bot.id, file: avatarDraft.file, assertActive: assert })
          assert()
        } catch (e) {
          try { assert() } catch { return }
          if (isAbortError(e)) return
          avatarFailed = true
          toastApiError(e, "Bot created, but the avatar photo failed to upload", assert)
        }
      }
      if (!avatarFailed) toast.success(`Created ${name.trim()}`)
      assert()
      await onCreated?.(data.bot)
      assert()
      handleOpenChange(false)
    } catch (e) {
      if (isAbortError(e)) return
      toastApiError(e, "Couldn't create the bot", assert)
    }
  }

  return (
    <CommunitySheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Create a bot"
      description={onAskBotToCreate ? (
        <Button variant="ghost" size="sm" type="button" onClick={() => void onAskBotToCreate()} disabled={askingBotToCreate} aria-busy={askingBotToCreate} className="h-auto w-fit max-w-full whitespace-normal justify-start rounded-sm text-left text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"><span aria-hidden="true">👉 </span>Ask your bot to create more bots.</Button>
      ) : undefined}
      bodyClassName="flex flex-col gap-6"
      footer={(requestClose) => (
        <>
          <Button variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || uploadBotAvatar.isPending || (requiresExplicitModel(runtime) && !model?.trim())}>
            {create.isPending ? "Creating…" : "Create bot"}
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
            nameError={fieldErrors.name}
          />

          <BotMachineField machines={machines} machineId={machineId} onChange={selectMachine} error={fieldErrors.machineId} />

          {selectedMachine && (
            <div className="flex flex-col gap-2">
              <BotRuntimeFields
                machineId={selectedMachine.id}
                options={runtimeOptions}
                runtime={runtime}
                model={model}
                daemonVersion={selectedMachine?.daemonVersion}
                reasoningEffort={reasoningEffort}
                onRuntimeChange={selectRuntime}
                onModelChange={(next) => { setModel(next); setFieldErrors((prev) => ({ ...prev, model: undefined })) }}
                onReasoningEffortChange={setReasoningEffort}
                radioName="bot-runtime"
                runtimeError={fieldErrors.runtime}
                modelError={fieldErrors.model}
                disableUnhealthyOptions
              />
            </div>
          )}
    </CommunitySheet>
  )
}
