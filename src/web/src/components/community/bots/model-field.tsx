"use client"

import { useEffect, useMemo, useState } from "react"
import {
  getRuntimeModelCatalog,
  runtimeSupportsModel,
  modelSelectState,
  modelNameFromSelect,
  MODEL_SELECT_DEFAULT,
  MODEL_SELECT_CUSTOM,
} from "@alook/shared"
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
 * Per-bot model picker. A `Select` over `[Default, ...catalog, Custom…]` plus a
 * conditionally-rendered custom text input. All model-name ↔ Select translation
 * goes through the shared `bot-model` helpers — never ad-hoc string logic.
 *
 * Renders nothing when the runtime doesn't honor a launch model (antigravity):
 * offering the choice would be a lie.
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
  runtime: string | null
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
}) {
  const catalog = useMemo(() => getRuntimeModelCatalog(runtime), [runtime])
  const seed = useMemo(() => modelSelectState(runtime, value), [runtime, value])

  const [selectValue, setSelectValue] = useState(seed.selectValue)
  const [customName, setCustomName] = useState(seed.customName)

  // Re-seed on external value/runtime changes only. Our own onChange echoes back
  // as a `value` that already round-trips to local state, so this no-ops for it.
  useEffect(() => {
    const resolved = modelNameFromSelect(selectValue, customName)
    if (resolved !== (value ?? null)) {
      setSelectValue(seed.selectValue)
      setCustomName(seed.customName)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, value])

  if (!runtimeSupportsModel(runtime)) return null

  const isCustom = selectValue === MODEL_SELECT_CUSTOM
  const defaultLabel = runtime ? `Default (${runtime}'s own default)` : "Default"

  // Base UI resolves the collapsed-trigger label from `items` (value → label).
  // Without it, SelectValue renders the raw value — fine for catalog ids
  // (value === label) but leaks the `__default__` / `__custom__` sentinels.
  // Same pattern as runtime-select.tsx.
  const items = [
    { value: MODEL_SELECT_DEFAULT, label: defaultLabel },
    ...catalog.models.map((m) => ({ value: m, label: m })),
    { value: MODEL_SELECT_CUSTOM, label: "Custom…" },
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
        disabled={disabled}
      >
        <SelectTrigger
          data-testid="bot-model-select"
          className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-8"
        >
          <SelectValue placeholder={defaultLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MODEL_SELECT_DEFAULT}>{defaultLabel}</SelectItem>
          {catalog.models.map((m) => (
            <SelectItem key={m} value={m}>
              <span className="font-mono">{m}</span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={MODEL_SELECT_CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && (
        <Input
          data-testid="bot-model-custom-input"
          value={customName}
          disabled={disabled}
          placeholder="e.g. claude-sonnet-4-6"
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
