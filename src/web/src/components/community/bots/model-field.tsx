"use client"

import { useEffect, useMemo, useState } from "react"
import {
  modelSelectState,
  modelNameFromSelect,
  MODEL_SELECT_DEFAULT,
  MODEL_SELECT_CUSTOM,
} from "@alook/shared"
import type { CommunityMachineRuntime } from "@alook/shared"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectSeparator,
} from "@/components/ui/select"

/**
 * Per-bot model picker. A `Select` over `[Default, Custom…, ...catalog]` plus a
 * conditionally-rendered custom text input. All model-name ↔ Select translation
 * goes through the shared `bot-model` helpers — never ad-hoc string logic.
 *
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
}: {
  runtime: Pick<CommunityMachineRuntime, "id" | "reasoning"> | null
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
}) {
  const modelIds = useMemo(
    () => runtime?.reasoning?.models
      .map((model) => model.id)
      .filter((id) => id !== MODEL_SELECT_DEFAULT && id !== MODEL_SELECT_CUSTOM) ?? [],
    [runtime],
  )
  const seed = useMemo(() => modelSelectState(modelIds, value), [modelIds, value])

  const [selectValue, setSelectValue] = useState(seed.selectValue)
  const [customName, setCustomName] = useState(seed.customName)
  const [filterQuery, setFilterQuery] = useState("")

  // Re-seed whenever the selected machine/runtime snapshot or stored value
  // changes. This is required even when the stored string is unchanged: a
  // value can be a reported option on machine A and Custom… on machine B.
  useEffect(() => {
    setSelectValue(seed.selectValue)
    setCustomName(seed.customName)
    setFilterQuery("")
  }, [seed])

  const isCustom = selectValue === MODEL_SELECT_CUSTOM
  const defaultLabel = runtime ? `Default (${runtime.id}'s own default)` : "Default"
  const normalizedFilter = filterQuery.trim().toLowerCase()
  const filteredModelIds = normalizedFilter
    ? modelIds.filter((model) => model.toLowerCase().includes(normalizedFilter))
    : modelIds

  // Base UI resolves the collapsed-trigger label from `items` (value → label).
  // Without it, SelectValue renders the raw value — fine for catalog ids
  // (value === label) but leaks the `__default__` / `__custom__` sentinels.
  // Same pattern as runtime-select.tsx.
  const items = [
    { value: MODEL_SELECT_DEFAULT, label: defaultLabel },
    { value: MODEL_SELECT_CUSTOM, label: "Custom…" },
    ...modelIds.map((model) => ({ value: model, label: model })),
  ]

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">Model</Label>
      <Select
        items={items}
        value={selectValue}
        onValueChange={(next: string | null) => {
          // Base UI can emit `null` on clear — treat it as Default.
          const nextValue = next ?? MODEL_SELECT_DEFAULT
          setSelectValue(nextValue)
          // Custom… keeps the text field revealed even when empty (emits null
          // until something is typed); any other value maps through the helper.
          onChange(modelNameFromSelect(nextValue, customName))
        }}
        onOpenChange={(open) => {
          if (!open) setFilterQuery("")
        }}
        disabled={disabled}
      >
        <SelectTrigger
          data-testid="bot-model-select"
          className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-8"
        >
          <SelectValue placeholder={defaultLabel} />
        </SelectTrigger>
        <SelectContent className="overflow-y-hidden">
          {modelIds.length === 0 ? (
            <>
              <SelectItem value={MODEL_SELECT_DEFAULT}>{defaultLabel}</SelectItem>
              <SelectItem value={MODEL_SELECT_CUSTOM}>Custom…</SelectItem>
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
                <SelectItem value={MODEL_SELECT_DEFAULT}>{defaultLabel}</SelectItem>
                <SelectItem value={MODEL_SELECT_CUSTOM}>Custom…</SelectItem>
                <SelectSeparator />
              </div>
              <div
                data-testid="bot-model-probe-results"
                className="thin-scrollbar max-h-[min(18rem,50dvh)] overflow-y-auto"
              >
                {filteredModelIds.map((model) => (
                  <SelectItem key={model} value={model}>
                    <span className="font-mono">{model}</span>
                  </SelectItem>
                ))}
                {normalizedFilter && filteredModelIds.length === 0 ? (
                  <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                    No matching models
                  </p>
                ) : null}
              </div>
            </>
          )}
        </SelectContent>
      </Select>
      {isCustom && (
        <Input
          data-testid="bot-model-custom-input"
          value={customName}
          disabled={disabled}
          placeholder="e.g. provider/model-id"
          onChange={(e) => {
            setCustomName(e.target.value)
            onChange(modelNameFromSelect(MODEL_SELECT_CUSTOM, e.target.value))
          }}
          className="h-11 font-mono sm:h-8"
        />
      )}
    </div>
  )
}
