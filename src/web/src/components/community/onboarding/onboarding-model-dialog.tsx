"use client"

import type { CommunityMachineRuntime } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { ProviderLogo } from "@/components/provider-logo"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ModelField } from "../bots/model-field"
import { validateBotModel } from "../bots/bot-form-validation"
import { ONBOARDING_HARNESSES } from "./onboarding-form-options"

export function OnboardingModelDialog({ runtime, model, onModelChange, onContinue }: {
  runtime: Pick<CommunityMachineRuntime, "id" | "reasoning">
  model: string | null
  onModelChange: (model: string | null) => void
  onContinue: () => void
}) {
  const error = validateBotModel(model, runtime.id)
  const backendLabel = ONBOARDING_HARNESSES.find((option) => option.value === runtime.id)?.label ?? runtime.id
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm" className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto border-0 p-0 shadow-(--e2) ring-0 thin-scrollbar sm:max-w-md">
        <form onSubmit={(event) => { event.preventDefault(); if (!error) onContinue() }}>
          <DialogHeader className="gap-4 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
            <div className="flex gap-1.5" aria-label="Step 3 of 4">
              {[1, 2, 3, 4].map((step) => <span key={step} className={step <= 3 ? "h-1.5 flex-1 rounded-full bg-primary" : "h-1.5 flex-1 rounded-full bg-muted"} />)}
            </div>
            <DialogTitle className="flex flex-wrap items-center gap-x-2 text-2xl leading-tight font-semibold tracking-tight">
              <span>Choose a model for your</span>
              <span className="inline-flex items-center gap-2 whitespace-nowrap"><ProviderLogo provider={runtime.id} className="size-5" />{backendLabel}</span>
            </DialogTitle>
            <DialogDescription>Your team’s bots will use this model. You can change it for each bot later.</DialogDescription>
          </DialogHeader>
          <div className="px-4 pb-4 sm:px-6 sm:pb-6">
            <ModelField runtime={runtime} value={model} onChange={onModelChange} error={model ? error : undefined} />
          </div>
          <DialogFooter className="m-0 rounded-none border-0 bg-transparent px-4 py-4 sm:px-6">
            <Button type="submit" className="h-11 min-h-11 w-full sm:h-9 sm:min-h-9 sm:w-auto" disabled={Boolean(error)}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
