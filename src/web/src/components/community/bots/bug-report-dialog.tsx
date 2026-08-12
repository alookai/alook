"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  bugReportErrorMessage,
  type BugReportPhase,
  type BugReportUiErrorCode,
  useBotBugReport,
} from "@/hooks/community/use-bot-bug-report"
import { tid } from "@/lib/community/testids"

type BugIdentity = { id: string; name: string }

type DialogViewProps = {
  bot: BugIdentity
  open: boolean
  phase: BugReportPhase
  isSubmitting: boolean
  reportId: string | null
  errorCode: BugReportUiErrorCode | null
  onConfirm: () => void | Promise<void>
  onOpenChange: (open: boolean) => void
}

type BugReportDialogProps =
  | (Pick<DialogViewProps, "bot" | "open" | "onOpenChange"> & { phase?: never })
  | DialogViewProps

function statusTitle(phase: BugReportPhase, errorCode: BugReportUiErrorCode | null): string {
  if (phase === "failed" && errorCode === "rate_limited") return "A report was sent recently"
  if (phase === "collecting") return "Collecting diagnostics"
  if (phase === "uploaded") return "Report uploaded"
  if (phase === "timeout") return "Collection timed out"
  return "Report failed"
}

function ReportIdCopy({ reportId }: { reportId: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportId)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("failed")
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-foreground">Report ID</span>
      <code className="font-mono text-xs text-muted-foreground">{reportId}</code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-label="Copy report ID"
        onClick={() => void copy()}
      >
        Copy
      </Button>
      {copyStatus === "copied" && <span className="text-xs text-muted-foreground">Copied</span>}
      {copyStatus === "failed" && (
        <span className="text-xs text-muted-foreground">Couldn’t copy. Select the ID instead.</span>
      )}
    </div>
  )
}

function BugReportDialogView(props: DialogViewProps) {
  const status = props.phase !== "confirm" && props.phase !== "submitting"
  const submitLabel = props.phase === "failed" || props.phase === "timeout"
    ? "Try again"
    : props.isSubmitting
      ? "Submitting…"
      : "Confirm"
  const showSubmit = props.phase !== "collecting"
    && props.phase !== "uploaded"
    && !(props.phase === "failed" && props.errorCode === "rate_limited")

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent data-testid={tid.botReportProblemDialog}>
        <AlertDialogHeader>
          <AlertDialogTitle>Report a problem with {props.bot.name}?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 text-left">
            <span className="block">
              We’ll upload only program logs needed to diagnose the problem.
            </span>
            <span className="block">
              We won’t read or upload your agent’s local chat history or files.
            </span>
            <span className="block">Reports are deleted after 7 days.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {status && (
          <div
            data-testid={tid.botReportProblemStatus}
            className="rounded-md bg-muted/60 px-3 py-2 text-sm"
          >
            <p className="font-medium text-foreground">{statusTitle(props.phase, props.errorCode)}</p>
            {props.phase === "failed" && (
              <p className="mt-1 text-muted-foreground">
                {bugReportErrorMessage(props.errorCode)}
              </p>
            )}
            {props.reportId && (
              <ReportIdCopy key={props.reportId} reportId={props.reportId} />
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {showSubmit && (
            <Button
              data-testid={tid.botReportProblemSubmit}
              disabled={props.isSubmitting}
              onClick={() => void props.onConfirm()}
            >
              {submitLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ConnectedBugReportDialog({
  bot,
  open,
  onOpenChange,
}: Pick<DialogViewProps, "bot" | "open" | "onOpenChange">) {
  const { state, confirm } = useBotBugReport({ agentId: bot.id, open })
  return (
    <BugReportDialogView
      bot={bot}
      open={open}
      phase={state.phase}
      isSubmitting={state.phase === "submitting"}
      reportId={state.reportId}
      errorCode={state.errorCode}
      onConfirm={confirm}
      onOpenChange={onOpenChange}
    />
  )
}

export function BugReportDialog(props: BugReportDialogProps) {
  if (props.phase !== undefined) return <BugReportDialogView {...props} />
  return <ConnectedBugReportDialog {...props} />
}
