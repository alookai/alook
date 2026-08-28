"use client"

import { useEffect, useMemo } from "react"
import {
  resolveReasoningEffort,
  type ReasoningEffort,
  type RuntimeReasoningDescriptor,
} from "@alook/shared"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { tid } from "@/lib/community/testids"

const DEFAULT_VALUE = "__default__"

function effortLabel(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

export function ReasoningEffortField({
  runtime,
  model,
  value,
  onChange,
  disabled,
}: {
  runtime: RuntimeReasoningDescriptor | null
  model: string | null
  value: ReasoningEffort | null
  onChange: (value: ReasoningEffort | null) => void
  disabled?: boolean
}) {
  const resolution = useMemo(
    () => resolveReasoningEffort(runtime, model, value),
    [runtime, model, value],
  )

  useEffect(() => {
    if (!resolution.supported && value !== null) onChange(null)
  }, [onChange, resolution.supported, value])

  const defaultLabel = resolution.defaultReasoningEffort
    ? `Default (${effortLabel(resolution.defaultReasoningEffort)})`
    : "Default"
  const items = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...resolution.options.map((option) => ({
      value: option.value,
      label: effortLabel(option.value),
    })),
  ]
  const selected = value ?? DEFAULT_VALUE
  const selectedDescription = value
    ? resolution.options.find((option) => option.value === value)?.description
    : undefined
  const unavailable = resolution.options.length === 0

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">Reasoning effort</Label>
      <Select
        items={items}
        value={selected}
        onValueChange={(next: string | null) => {
          onChange(!next || next === DEFAULT_VALUE ? null : next)
        }}
        disabled={disabled || unavailable}
      >
        <SelectTrigger
          data-testid={tid.botReasoningEffort}
          className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-8"
          aria-describedby="bot-reasoning-effort-help"
        >
          <SelectValue placeholder={defaultLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem>
          {resolution.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {effortLabel(option.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="bot-reasoning-effort-help" className="text-xs text-muted-foreground">
        {unavailable
          ? "This runtime/model does not report reasoning effort options."
          : selectedDescription ?? "Default lets the runtime choose for this model."}
      </p>
    </div>
  )
}
