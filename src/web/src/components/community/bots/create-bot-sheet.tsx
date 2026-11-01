"use client"
import { BotMachineField } from "./bot-machine-field"
import type { MachineSummary } from "@/hooks/community/use-machines"

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
import { machineName } from "@/lib/community/machine-name"
import { runtimeLabel } from "@/lib/community/runtime-label"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
import { type AvatarDraft } from "@/components/avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { randomBotName } from "@/lib/community/bot-random-name"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCreateBot, useUploadBotAvatar } from "@/hooks/community/use-bots"
import { BotFormFields } from "./bot-form-fields"
import { BotRuntimeFields, type BotRuntimeOption } from "./bot-runtime-fields"
import {
  type BotCreateFieldErrors,
  hasBotCreateFieldErrors,
  validateBotCreateFields,
} from "./bot-form-validation"
import type { BotSummary } from "@/hooks/community/use-bots"

// Stable initial seed avoids hydration mismatch (real seed is rerolled on mount).
const INITIAL_AVATAR = serializeBeamSeed("initial")

type NormalizedRuntime = BotRuntimeOption

/**
 * Normalize a machine's runtimes into `{ id, unhealthy }`, healthy-first.
 *
 * A legacy MachineSummary cached client-side may still be missing
 * availableRuntimes, or a runtime entry may still be a bare string
 * (pre-health-status shape). Normalize both instead of hiding unhealthy
 * runtimes outright, so the radio card can show *why* an option is disabled.
 * Available runtimes sort first — the ones you can actually pick should never
 * be buried below ones you can't.
 */
export function normalizeRuntimes(machine: MachineSummary | undefined): NormalizedRuntime[] {
  const rt = machine?.availableRuntimes ?? []
  const normalized = rt.map((r) =>
    typeof r === "string"
      ? { id: r, unhealthy: false }
      : {
          id: r.id,
          ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
          unhealthy: r.status === "unhealthy",
        },
  )
  return normalized.sort((a, b) => Number(a.unhealthy) - Number(b.unhealthy))
}

/** First healthy (selectable) runtime id, or "" if none. */
export function firstHealthyRuntimeId(options: NormalizedRuntime[]): string {
  return options.find((o) => !o.unhealthy)?.id ?? ""
}

/** First online (selectable) machine id, or "" if none. */
export function firstOnlineMachineId(machines: MachineSummary[]): string {
  return machines.find((m) => isPresenceOnline(m.status))?.id ?? ""
}

export function CreateBotSheet({
  open,
  onOpenChange,
  onCreated,
  guided = false,
  avatarSeed,
  onAskBotToCreate,
  askingBotToCreate = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (bot: BotSummary) => void | Promise<void>
  guided?: boolean
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
  const [technicalExpanded, setTechnicalExpanded] = useAtom(useCreateAtom(false))
  const [avatarDraft, setAvatarDraft] = useAtom(useCreateAtom<AvatarDraft>({
    kind: "procedural",
    image: INITIAL_AVATAR,
  }))

  const selectedMachine = machines.find((m) => m.id === machineId)
  const runtimeOptions = useMemo(() => normalizeRuntimes(selectedMachine), [selectedMachine])
  const singleTechnicalDefault =
    guided &&
    !requiresExplicitModel(runtime) &&
    Boolean(selectedMachine && runtime) &&
    machines.filter((machine) => isPresenceOnline(machine.status)).length === 1 &&
    runtimeOptions.filter((option) => !option.unhealthy).length === 1

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
    setTechnicalExpanded(false)
  }, [open, avatarSeed, initialization, setName, setAvatarDraft, setDescription, setMachineId, setRuntime, setModel, setReasoningEffort, setFieldErrors, setTechnicalExpanded])

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
        <button type="button" onClick={() => void onAskBotToCreate()} disabled={askingBotToCreate} aria-busy={askingBotToCreate} className="w-fit max-w-full rounded-sm text-left text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"><span aria-hidden="true">👉 </span>Ask your bot to create more bots.</button>
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

          {singleTechnicalDefault && !technicalExpanded ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5">
              <ProviderLogo provider={runtime} className="size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">Ready on {selectedMachine ? machineName(selectedMachine) : "your machine"}</p>
                <p className="text-xs text-muted-foreground">{runtimeLabel(runtime)} · Default model</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setTechnicalExpanded(true)}>Change</Button>
            </div>
          ) : (
          <>
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
          </>
          )}
    </CommunitySheet>
  )
}
