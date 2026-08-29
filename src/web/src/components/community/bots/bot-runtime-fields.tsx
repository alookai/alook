"use client"

import { ProviderLogo } from "@/components/provider-logo"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { ModelField } from "./model-field"
import { ReasoningEffortField } from "./reasoning-effort-field"
import type { CommunityMachineRuntime, ReasoningEffort } from "@alook/shared"

export type BotRuntimeOption = Pick<CommunityMachineRuntime, "id" | "reasoning"> & {
  unhealthy: boolean
}

const ignoreReasoningEffortChange = () => {}

export function BotRuntimeFields({
  options,
  runtime,
  model,
  reasoningEffort = null,
  onRuntimeChange,
  onModelChange,
  onReasoningEffortChange = ignoreReasoningEffortChange,
  radioName = "edit-bot-runtime",
  motionTargetPrefix,
  modelMotionTarget,
  runtimeOptionClassName,
  modelClassName,
  runtimeError,
  disableUnhealthyOptions = false,
}: {
  options: BotRuntimeOption[]
  runtime: string
  model: string | null
  reasoningEffort?: ReasoningEffort | null
  onRuntimeChange: (runtime: string) => void
  onModelChange: (model: string | null) => void
  onReasoningEffortChange?: (effort: ReasoningEffort | null) => void
  radioName?: string
  motionTargetPrefix?: string
  modelMotionTarget?: string
  runtimeOptionClassName?: (runtime: string) => string | undefined
  modelClassName?: string
  runtimeError?: string
  disableUnhealthyOptions?: boolean
}) {
  const selectedRuntime = options.find((option) => option.id === runtime) ?? null

  function selectRuntime(next: string) {
    if (next === runtime) return
    onRuntimeChange(next)
    onModelChange(null)
    onReasoningEffortChange(null)
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label className="text-xs text-muted-foreground">Runtime</Label>
        {options.length === 0 ? (
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
            {options.map((option) => {
              const selected = runtime === option.id
              const disabled = option.unhealthy && (disableUnhealthyOptions || !selected)
              return (
                <label
                  key={option.id}
                  data-motion-target={
                    motionTargetPrefix ? `${motionTargetPrefix}-${option.id}` : undefined
                  }
                  className={cn(
                    "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border/50 hover:border-foreground/20",
                    disabled && "opacity-40 pointer-events-none",
                    runtimeOptionClassName?.(option.id),
                  )}
                >
                  <input
                    type="radio"
                    name={radioName}
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
        {runtimeError ? <p className="text-xs text-destructive">{runtimeError}</p> : null}
      </div>
      {runtime ? (
        <div data-motion-target={modelMotionTarget} className={cn("flex flex-col gap-4", modelClassName)}>
          <ModelField runtime={selectedRuntime} value={model} onChange={onModelChange} />
          <ReasoningEffortField
            runtime={selectedRuntime}
            model={model}
            value={reasoningEffort}
            onChange={onReasoningEffortChange}
          />
        </div>
      ) : null}
    </>
  )
}
