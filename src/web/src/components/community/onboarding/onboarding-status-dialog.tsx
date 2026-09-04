"use client"

import { CheckIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react"

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

export function OnboardingStatusDialog({
  status,
  detail,
  onRetry,
  onContinue,
}: {
  status: "loading" | "error" | "success"
  detail: string
  onRetry: () => void
  onContinue: () => void
}) {
  return (
    <Dialog open>
      <DialogContent
        data-testid={tid.onboardingInitializeStatus}
        showCloseButton={false}
        overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        className="gap-0 overflow-hidden border-0 p-0 shadow-(--e2) ring-0 sm:max-w-md"
        aria-busy={status === "loading"}
      >
        <DialogHeader className="gap-2 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
          <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight">
            {status === "success" ? "Your room is ready" : "Building your bot room"}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">{detail}</DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <div
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
            className="flex min-h-16 items-center gap-3 rounded-lg bg-muted/40 px-3 py-3 text-sm"
          >
            {status === "loading" ? (
              <LoaderCircleIcon className="size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            ) : status === "success" ? (
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                <CheckIcon className="size-4" />
              </span>
            ) : (
              <RefreshCwIcon className="size-5 shrink-0 text-destructive" />
            )}
            <span className={status === "error" ? "text-destructive" : "text-muted-foreground"}>
              {status === "loading"
                ? "Keep this window open."
                : status === "success"
                  ? "Both bots are waiting inside."
                  : "Retry to continue where setup stopped."}
            </span>
          </div>
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
