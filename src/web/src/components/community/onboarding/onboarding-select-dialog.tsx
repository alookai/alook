"use client"

/* Hallmark · component: onboarding selection dialog · genre: modern-minimal · theme: Alook locked system
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */

import { useId, type FormEvent } from "react"
import {
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ProviderLogo } from "@/components/provider-logo"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { tagColorClassName, tagColorStyle } from "@/lib/community/tag-color"
import { cn } from "@/lib/utils"
import {
  changeOnboardingCustomValue,
  selectOnboardingOption,
} from "./onboarding-selection-state"

export type OnboardingSelectOption = {
  value: string
  label: string
  description?: string
  disabled?: boolean
  icon?: LucideIcon
  provider?: string
  accentKey?: string
}

type OnboardingSelectDialogStatus =
  | "idle"
  | "loading"
  | "error"
  | "success"

export type OnboardingSelectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  step?: { current: number; total: number }
  stepLabel?: string
  title: string
  description?: string
  options: OnboardingSelectOption[]
  value: string
  onValueChange: (value: string) => void
  customOption?: {
    value: string
    label: string
    placeholder: string
  }
  customValue?: string
  onCustomValueChange?: (value: string) => void
  submitLabel: string
  loadingLabel?: string
  onSubmit: (value: string) => void
  secondaryLabel?: string
  onSecondaryAction?: () => void
  refreshLabel?: string
  onRefresh?: () => void
  refreshing?: boolean
  status?: OnboardingSelectDialogStatus
  feedback?: string
  disabled?: boolean
  dismissible?: boolean
  testId?: string
  optionTestId?: (value: string) => string
}

function optionId(baseId: string, value: string) {
  return `${baseId}-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

const progressColors = ["bg-(--te)", "bg-(--ti)", "bg-(--tc)"] as const

export function OnboardingSelectDialog({
  open,
  onOpenChange,
  step,
  stepLabel,
  title,
  description,
  options,
  value,
  onValueChange,
  customOption,
  customValue = "",
  onCustomValueChange,
  submitLabel,
  loadingLabel = "Saving…",
  onSubmit,
  secondaryLabel,
  onSecondaryAction,
  refreshLabel = "Refresh options",
  onRefresh,
  refreshing = false,
  status = "idle",
  feedback,
  disabled = false,
  dismissible = false,
  testId,
  optionTestId,
}: OnboardingSelectDialogProps) {
  const id = useId()
  const busy = status === "loading" || refreshing
  const locked = disabled || busy || status === "success"
  const customSelected = value === customOption?.value
  const submittedValue = customSelected ? customValue.trim() : value
  const canSubmit = Boolean(submittedValue)
  const invalid = status === "error"

  const handleValueChange = (nextValue: string) => {
    const nextState = selectOnboardingOption(
      { value, customValue },
      nextValue,
      customOption?.value,
    )
    onValueChange(nextState.value)
    if (nextState.customValue !== customValue) {
      onCustomValueChange?.(nextState.customValue)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || locked) return
    onSubmit(submittedValue)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || dismissible) onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        data-testid={testId}
        showCloseButton={dismissible}
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto border-0 p-0 shadow-(--e2) ring-1 ring-foreground/10 thin-scrollbar sm:max-w-xl"
        aria-busy={busy}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader className="gap-4 px-4 pt-4 pb-5 sm:px-6 sm:pt-6">
            {step ? (
              <div className="flex gap-1.5" aria-label={`Step ${step.current} of ${step.total}`}>
                {Array.from({ length: step.total }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      index < step.current
                        ? progressColors[index % progressColors.length]
                        : "bg-muted",
                    )}
                  />
                ))}
              </div>
            ) : null}
            <div className="flex min-w-0 items-center justify-between gap-4">
              {stepLabel ? (
                <p className="font-mono text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                  {stepLabel}
                </p>
              ) : (
                <span />
              )}
              {onRefresh ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11 px-2 text-muted-foreground sm:h-8"
                  onClick={onRefresh}
                  disabled={locked}
                >
                  <RefreshCwIcon
                    className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
                  />
                  {refreshLabel}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-[1.375rem] leading-tight font-semibold tracking-tight">
                {title}
              </DialogTitle>
              {description ? (
                <DialogDescription className="max-w-[56ch] leading-relaxed">
                  {description}
                </DialogDescription>
              ) : null}
            </div>
          </DialogHeader>

          <div className="px-4 pb-4 sm:px-6 sm:pb-6">
            <FieldSet disabled={locked}>
              <RadioGroup
                value={value}
                onValueChange={handleValueChange}
                disabled={locked}
                aria-invalid={invalid || undefined}
                aria-label={title}
                className="gap-3"
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {options.map((option) => {
                  const itemId = optionId(id, option.value)
                  const selected = value === option.value
                  const OptionIcon = option.icon
                  return (
                    <FieldLabel
                      key={option.value}
                      data-testid={optionTestId?.(option.value)}
                      htmlFor={itemId}
                      data-disabled={option.disabled || locked || undefined}
                      data-selected={selected || undefined}
                      className={cn(
                        "min-h-16 cursor-pointer rounded-xl border border-border bg-card p-3 text-left shadow-none transition-[border-color,background-color,box-shadow,transform] has-[>[data-slot=field]]:rounded-xl has-[>[data-slot=field]]:border-border *:data-[slot=field]:p-0 hover:-translate-y-px hover:border-foreground/25 hover:bg-accent/50 active:translate-y-0 active:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring/40 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:bg-muted/40 data-[disabled=true]:text-muted-foreground data-[selected=true]:bg-accent/30",
                        selected && "border-foreground/60 shadow-(--e1) ring-1 ring-foreground/10 has-[>[data-slot=field]]:border-foreground/60",
                      )}
                    >
                      <Field orientation="horizontal" className="items-center gap-3">
                        <span
                          aria-hidden
                          className={cn(
                            tagColorClassName,
                            "grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-current/10",
                          )}
                          style={tagColorStyle(option.accentKey ?? option.value)}
                        >
                          {option.provider ? (
                            <ProviderLogo provider={option.provider} className="size-5" />
                          ) : OptionIcon ? (
                            <OptionIcon className="size-4" />
                          ) : (
                            <span className="text-xs font-semibold uppercase">
                              {option.label.slice(0, 1)}
                            </span>
                          )}
                        </span>
                        <FieldContent>
                          <FieldTitle>{option.label}</FieldTitle>
                          {option.description ? (
                            <FieldDescription>{option.description}</FieldDescription>
                          ) : null}
                        </FieldContent>
                        <RadioGroupItem
                          id={itemId}
                          value={option.value}
                          disabled={option.disabled || locked}
                          aria-invalid={invalid || undefined}
                          className="shrink-0"
                        />
                      </Field>
                    </FieldLabel>
                  )
                })}
                </div>

              </RadioGroup>

              {customOption ? (
                <Field className="gap-2 pt-1">
                  <FieldLabel
                    htmlFor={optionId(id, `${customOption.value}-input`)}
                    className="text-sm font-medium"
                  >
                    {customOption.label}
                  </FieldLabel>
                  <Input
                    data-testid={optionTestId?.(customOption.value)}
                    id={optionId(id, `${customOption.value}-input`)}
                    value={customValue}
                    onChange={(event) => {
                      const nextState = changeOnboardingCustomValue(
                        event.target.value,
                        customOption.value,
                      )
                      onValueChange(nextState.value)
                      onCustomValueChange?.(nextState.customValue)
                    }}
                    placeholder={customOption.placeholder}
                    autoComplete="organization-title"
                    disabled={locked}
                    aria-invalid={(customSelected && invalid) || undefined}
                    className={cn(
                      "h-11 bg-card px-3",
                      customSelected && "border-foreground/50 ring-1 ring-foreground/10",
                    )}
                  />
                </Field>
              ) : null}
            </FieldSet>

            {feedback ? (
              <div aria-live="polite" className="mt-4 flex items-start gap-2 text-sm">
                {status === "error" ? <FieldError>{feedback}</FieldError> : null}
                {status === "success" ? (
                  <p className="flex items-center gap-2 text-foreground">
                    <CheckIcon className="mt-0.5 size-4 shrink-0" />
                    {feedback}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter className="m-0 rounded-none border-t border-border/60 bg-transparent px-4 py-4 sm:px-6">
            {secondaryLabel && onSecondaryAction ? (
              <Button
                type="button"
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={onSecondaryAction}
                disabled={busy}
              >
                {secondaryLabel}
              </Button>
            ) : null}
            <Button
              type="submit"
              className="h-11 w-full sm:h-9 sm:w-auto"
              disabled={!canSubmit || locked}
            >
              {status === "loading" ? (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              ) : status === "success" ? (
                <CheckIcon />
              ) : null}
              {status === "loading" ? loadingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
