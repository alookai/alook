"use client"

import Image from "next/image"
import { CheckCircle2Icon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react"

import { ProfileAvatar } from "@/components/avatar"
import { ServerIcon } from "@/components/community/server-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { tid } from "@/lib/community/testids"
import { avatarInitial } from "@/lib/community/avatar"
import {
  ONBOARDING_INITIALIZATION_LABEL,
  ONBOARDING_INITIALIZATION_STEPS,
  type OnboardingInitializationCheckpoint,
  type OnboardingInitializationStep,
} from "./initialize-community-onboarding"

export function OnboardingStatusDialog({
  status,
  currentStep,
  checkpoint = {},
  detail,
  onRetry,
  onContinue,
}: {
  status: "loading" | "error" | "success"
  currentStep: OnboardingInitializationStep
  checkpoint?: OnboardingInitializationCheckpoint
  detail: string
  onRetry: () => void
  onContinue: () => void
}) {
  const currentStepIndex = ONBOARDING_INITIALIZATION_STEPS.indexOf(currentStep)
  const visibleSteps = ONBOARDING_INITIALIZATION_STEPS.slice(
    0,
    status === "success" ? ONBOARDING_INITIALIZATION_STEPS.length : currentStepIndex + 1,
  )

  return (
    <Dialog open>
      <DialogContent
        data-testid={tid.onboardingInitializeStatus}
        showCloseButton={false}
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        className="gap-0 overflow-hidden border-0 p-0 shadow-(--e2) ring-0 sm:max-w-md"
        aria-busy={status === "loading"}
      >
        <DialogHeader className="gap-4 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
          <div className="grid grid-cols-3 gap-1" aria-label="Step 3 of 3">
            <span className="h-1 rounded-full bg-(--te)" />
            <span className="h-1 rounded-full bg-(--ti)" />
            <span className="h-1 rounded-full bg-(--tc)" />
          </div>
          <div className="flex flex-col gap-2">
            <DialogTitle className="flex flex-wrap items-center gap-x-2 text-2xl leading-tight font-semibold tracking-tight">
              {status === "success" ? <span>Your</span> : <span>Building your</span>}
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <Image
                  src="/icon-192.png"
                  alt=""
                  aria-hidden
                  width={20}
                  height={20}
                  className="size-5 object-contain"
                />
                {status === "success" ? "room" : "bot room"}
              </span>
              {status === "success" ? <span>is ready</span> : null}
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              {status === "loading" ? "Follow along as your room comes together." : detail}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
            aria-label="Setup progress"
            className="space-y-0 px-1"
          >
            {visibleSteps.map((step, index) => {
              const isComplete = status === "success" || index < currentStepIndex
              const isError = status === "error" && index === currentStepIndex
              return (
                <li
                  key={step}
                  className="relative grid min-h-9 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 pb-3 last:min-h-5 last:pb-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200 motion-reduce:animate-none"
                >
                  {index < visibleSteps.length - 1 ? (
                    <span
                      aria-hidden
                      className="absolute top-5 -bottom-3 left-[0.59375rem] w-px bg-border"
                    />
                  ) : null}
                  <span className="relative z-10 flex size-5 items-center justify-center bg-popover">
                    {isComplete ? (
                      <CheckCircle2Icon className="size-5 text-foreground" aria-hidden />
                    ) : isError ? (
                      <RefreshCwIcon className="size-5 text-destructive" aria-hidden />
                    ) : (
                      <LoaderCircleIcon
                        className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                        aria-hidden
                      />
                    )}
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <p
                      className={
                        isError ? "min-w-0 font-medium leading-5 text-destructive" : "min-w-0 font-medium leading-5"
                      }
                    >
                      {ONBOARDING_INITIALIZATION_LABEL[step]}
                    </p>
                    {isComplete && step === "creating-bots" && checkpoint.botAId && checkpoint.botBId ? (
                      <span className="flex shrink-0 -space-x-1" aria-label="Bots created">
                        <ProfileAvatar
                          label={checkpoint.botAName ?? "Bot"}
                          seed={checkpoint.botAId}
                          src={checkpoint.botAImage}
                          size={20}
                          className="ring-2 ring-popover"
                        />
                        <ProfileAvatar
                          label={checkpoint.botBName ?? "Bot"}
                          seed={checkpoint.botBId}
                          src={checkpoint.botBImage}
                          size={20}
                          className="ring-2 ring-popover"
                        />
                      </span>
                    ) : null}
                    {isComplete && step === "creating-room" && checkpoint.serverId ? (
                      <span className="shrink-0" aria-label="Server created">
                        <ServerIcon
                          id={checkpoint.serverId}
                          name={checkpoint.serverName ?? "Your server"}
                          initial={avatarInitial(checkpoint.serverName ?? "Your server")}
                          size={20}
                          className="rounded-md"
                        />
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        {status !== "loading" ? (
          <DialogFooter className="m-0 rounded-b-xl border-0 bg-transparent px-4 py-4 sm:px-6">
            {status === "error" ? (
              <Button
                type="button"
                className="h-11 sm:h-9"
                onClick={onRetry}
                data-testid={tid.onboardingInitializeRetry}
              >
                <RefreshCwIcon />
                Try again
              </Button>
            ) : (
              <Button type="button" className="h-11 sm:h-9" onClick={onContinue}>
                Enter my room
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
