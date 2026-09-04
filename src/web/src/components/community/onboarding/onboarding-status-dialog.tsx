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
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
        aria-busy={status === "loading"}
      >
        <DialogHeader className="gap-2 px-4 pt-4 pb-3 sm:px-6 sm:pt-6 sm:pb-4">
          <p className="text-xs font-medium text-muted-foreground">Setup</p>
          <DialogTitle className="text-lg leading-snug font-semibold">
            {status === "success" ? "Your bot room is ready" : "Bringing your bot team together"}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">{detail}</DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-5 sm:px-6 sm:pb-6">
          <div
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
            className="flex min-h-16 items-center gap-3 rounded-lg border bg-muted/30 px-3 py-3 text-sm"
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
                ? "Please keep this window open while setup finishes."
                : status === "success"
                  ? "Your bots are waiting for you inside."
                  : "Nothing was deleted. You can retry the unfinished setup."}
            </span>
          </div>
        </div>

        {status !== "loading" ? (
          <DialogFooter className="m-0 rounded-b-xl px-4 py-3 sm:px-6 sm:py-4">
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
