"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, useId, useMemo } from "react"
import { LoaderCircle } from "lucide-react"
import {
  modelSelectState,
  modelNameFromSelect,
  MODEL_SELECT_DEFAULT,
  MODEL_SELECT_CUSTOM,
  requiresExplicitModel,
} from "@alook/shared"
import type { CommunityMachineRuntime } from "@alook/shared"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from "@/components/ui/select"
import { BotSelectMenuContent, BotSelectMenuItem } from "./bot-select-menu"
import { runtimeLabel } from "@/lib/community/runtime-label"

/**
 * The picker keeps its OWN Select/custom-text state rather than deriving purely
 * from `value`, because "Custom… selected with an empty name" and "Default" both
 * map to a `null` stored value — only local state can tell them apart, so the
 * text input stays revealed after choosing Custom…. The state re-seeds from
 * props whenever `value`/`runtime` change externally (runtime switch, a
 * different bot opening), detected by comparing the incoming value against what
 * local state currently resolves to — so it never clobbers on its own echo.
 */
export function ModelField({
  runtime,
  value,
  onChange,
  disabled,
  error,
  discovery,
}: {
  runtime: Pick<CommunityMachineRuntime, "id" | "reasoning"> | null
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  error?: string
  discovery?: {
    isPending: boolean
    error: string | null
    onOpenChange: (open: boolean) => void
    retry: () => void
  }
}) {
  const hintId = useId()
  const required = requiresExplicitModel(runtime?.id)
  const models = useMemo(
    () => runtime?.reasoning?.models
      .filter((model) => model.id !== MODEL_SELECT_DEFAULT && model.id !== MODEL_SELECT_CUSTOM) ?? [],
    [runtime],
  )
  const modelIds = useMemo(() => models.map((model) => model.id), [models])
  const seed = useMemo(() => modelSelectState(modelIds, value), [modelIds, value])

  const [selectValue, setSelectValue] = useAtom(useCreateAtom(seed.selectValue))
  const [customName, setCustomName] = useAtom(useCreateAtom(seed.customName))
  const [filterQuery, setFilterQuery] = useAtom(useCreateAtom(""))
  const localChange = useCreateAtom<{ runtime: typeof runtime; value: string | null } | null>(null)

  // Re-seed whenever the selected machine/runtime snapshot or stored value
  // changes. This is required even when the stored string is unchanged: a
  // value can be a reported option on machine A and Custom… on machine B.
  useEffect(() => {
    const change = localChange.get()
    localChange.set(null)
    if (change && change.runtime === runtime && change.value === value) return
    setSelectValue(seed.selectValue)
    setCustomName(seed.customName)
    setFilterQuery("")
  }, [seed, runtime, value, localChange, setCustomName, setFilterQuery, setSelectValue])

  const isCustom = selectValue === MODEL_SELECT_CUSTOM
  const defaultLabel = runtime ? `Default (${runtimeLabel(runtime.id)}'s own default)` : "Default"
  const placeholder = required ? "Select a model" : defaultLabel
  const normalizedFilter = filterQuery.trim().toLowerCase()
  const filteredModels = normalizedFilter
    ? models.filter((model) => model.id.toLowerCase().includes(normalizedFilter)
      || model.displayName?.toLowerCase().includes(normalizedFilter))
    : models

  // Base UI resolves the collapsed-trigger label from `items` (value → label).
  // Without it, SelectValue renders the raw value — fine for catalog ids
  // (value === label) but leaks the `__default__` / `__custom__` sentinels.
  // Same pattern as runtime-select.tsx.
  const items = [
    ...(!required ? [{ value: MODEL_SELECT_DEFAULT, label: defaultLabel }] : []),
    { value: MODEL_SELECT_CUSTOM, label: "Custom…" },
    ...models.map((model) => ({
      value: model.id,
      label: model.displayName && model.displayName !== model.id
        ? `${model.id} — ${model.displayName}`
        : model.id,
    })),
  ]

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">{required ? "Model (required)" : "Model"}</Label>
      <Select
        items={items}
        value={required && selectValue === MODEL_SELECT_DEFAULT ? null : selectValue}
        onValueChange={(next: string | null, details) => {
          if (details.reason === "none" && normalizedFilter && modelIds.includes(selectValue)) {
            details.cancel()
            return
          }
          // Base UI can emit `null` on clear — treat it as Default.
          const nextValue = next ?? MODEL_SELECT_DEFAULT
          setSelectValue(nextValue)
          // Custom… keeps the text field revealed even when empty (emits null
          // until something is typed); any other value maps through the helper.
          const nextModel = modelNameFromSelect(nextValue, customName)
          localChange.set({ runtime, value: nextModel })
          onChange(nextModel)
        }}
        onOpenChange={(open) => {
          discovery?.onOpenChange(open)
          if (!open) setFilterQuery("")
        }}
        disabled={disabled}
      >
        <SelectTrigger
          data-testid="bot-model-select"
          aria-label="Model"
          aria-required={required}
          aria-describedby={required || error ? hintId : undefined}
          aria-invalid={Boolean(error)}
          aria-busy={discovery?.isPending || undefined}
          className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-8"
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <BotSelectMenuContent
          alignItemWithTrigger={false}
          className="flex flex-col overflow-y-hidden [&>[role=listbox]]:flex [&>[role=listbox]]:min-h-0 [&>[role=listbox]]:flex-col"
        >
          {discovery?.isPending && (
            <p role="status" className="flex shrink-0 items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              Loading models…
            </p>
          )}
          {discovery?.error && (
            <div className="flex shrink-0 items-center gap-2 px-2 py-2">
              <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">{discovery.error}</p>
              <Button type="button" variant="ghost" size="sm" className="h-11 shrink-0 sm:h-8"
                onClick={(event) => { event.stopPropagation(); discovery.retry() }}>
                Retry
              </Button>
            </div>
          )}
          {modelIds.length === 0 ? (
            <>
              {!required && <BotSelectMenuItem value={MODEL_SELECT_DEFAULT}>{defaultLabel}</BotSelectMenuItem>}
              <BotSelectMenuItem value={MODEL_SELECT_CUSTOM}>Custom…</BotSelectMenuItem>
            </>
          ) : (
            <>
              <div data-testid="bot-model-fixed-controls" className="shrink-0 bg-popover">
                <div className="p-1.5">
                  <Input
                    autoFocus
                    data-testid="bot-model-filter-input"
                    value={filterQuery}
                    placeholder="Filter models…"
                    aria-label="Filter models"
                    onChange={(event) => setFilterQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        const highlighted = event.currentTarget
                          .closest('[role="listbox"]')
                          ?.querySelector<HTMLElement>("[data-highlighted]")
                        if (highlighted) {
                          event.preventDefault()
                          event.stopPropagation()
                          highlighted.click()
                        }
                        return
                      }
                      if (!["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)) {
                        event.stopPropagation()
                      }
                    }}
                    className="h-10 font-mono sm:h-8"
                  />
                </div>
                {!required && <BotSelectMenuItem value={MODEL_SELECT_DEFAULT}>{defaultLabel}</BotSelectMenuItem>}
                <BotSelectMenuItem value={MODEL_SELECT_CUSTOM}>Custom…</BotSelectMenuItem>
                <SelectSeparator className="mx-1 my-1.5" />
              </div>
              <div
                data-testid="bot-model-probe-results"
                className="thin-scrollbar min-h-0 max-h-[min(18rem,50dvh)] overflow-y-auto"
              >
                {filteredModels.map((model) => (
                  <BotSelectMenuItem key={model.id} value={model.id}>
                    {model.displayName && model.displayName !== model.id ? (
                      <div className="flex min-w-0 flex-col items-start gap-0.5">
                        <span>{model.displayName}</span>
                        <span className="max-w-full break-all whitespace-normal font-mono text-xs text-muted-foreground">
                          {model.id}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono">{model.id}</span>
                    )}
                  </BotSelectMenuItem>
                ))}
                {normalizedFilter && filteredModels.length === 0 ? (
                  <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                    No matching models
                  </p>
                ) : null}
              </div>
            </>
          )}
        </BotSelectMenuContent>
      </Select>
      {isCustom && (
        <Input
          data-testid="bot-model-custom-input"
          aria-label="Custom model"
          aria-required={required}
          aria-describedby={required || error ? hintId : undefined}
          aria-invalid={Boolean(error)}
          value={customName}
          disabled={disabled}
          placeholder="e.g. provider/model-id"
          onChange={(e) => {
            setCustomName(e.target.value)
            const nextModel = modelNameFromSelect(MODEL_SELECT_CUSTOM, e.target.value)
            localChange.set({ runtime, value: nextModel })
            onChange(nextModel)
          }}
          className="h-11 font-mono sm:h-8"
        />
      )}
      {(required || error) && <p id={hintId} role={error ? "alert" : undefined} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{error ?? "Choose a model before saving."}</p>}
    </div>
  )
}
