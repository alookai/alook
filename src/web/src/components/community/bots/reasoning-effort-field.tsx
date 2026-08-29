"use client"

import { useEffect, useMemo } from "react"
import {
  releaseVersionGte,
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
const REASONING_CATALOG_MIN_DAEMON_VERSION = "0.1.25"

function effortLabel(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

export function ReasoningEffortField({
  runtime,
  model,
  daemonVersion,
  value,
  onChange,
  disabled,
}: {
  runtime: RuntimeReasoningDescriptor | null
  model: string | null
  daemonVersion?: string
  value: ReasoningEffort | null
  onChange: (value: ReasoningEffort | null) => void
  disabled?: boolean
}) {
  const resolution = useMemo(
    () => resolveReasoningEffort(runtime, model, value),
    [runtime, model, value],
  )

  useEffect(() => {
    if (resolution.options.length > 0 && !resolution.supported && value !== null) {
      onChange(null)
    }
  }, [onChange, resolution.options.length, resolution.supported, value])

  const defaultLabel = "Default"
  const options = value && !resolution.options.some((option) => option.value === value)
    ? [...resolution.options, { value }]
    : resolution.options
  const items = [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...options.map((option) => ({
      value: option.value,
      label: effortLabel(option.value),
    })),
  ]
  const selected = value ?? DEFAULT_VALUE
  const selectedDescription = value
    ? resolution.options.find((option) => option.value === value)?.description
    : undefined
  const unavailable = resolution.options.length === 0
  const needsCatalogUpgrade = unavailable
    && daemonVersion !== undefined
    && !releaseVersionGte(daemonVersion, REASONING_CATALOG_MIN_DAEMON_VERSION)
  const help = needsCatalogUpgrade
    ? "Check the daemon version in Machines, then update and restart it there."
    : unavailable
      ? "This runtime/model does not report reasoning effort options."
      : value === null
        ? "Default sends no override. Your runtime or user configuration stays in control."
        : selectedDescription ?? "Alook sends this reasoning effort as an explicit override."

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
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {effortLabel(option.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="bot-reasoning-effort-help" className="text-xs text-muted-foreground">
        {help}
      </p>
    </div>
  )
}
