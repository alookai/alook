"use client";

import { useState } from "react";
import { AlertCircle, RotateCw, Loader2 } from "lucide-react";
import { runtimeDisplayName } from "@/lib/runtime-display";

/**
 * A visually distinct error block that attributes a runtime error to the agent
 * runtime CLI (Claude Code / Codex / OpenCode) on the user's machine, making it
 * clear the error did NOT originate from Alook. See issue #236.
 *
 * Shared by message-list (failed-task chat message) and task-stream (in-stream
 * + task-level errors) so the presentation is identical everywhere.
 */
export function RuntimeErrorBlock({
  provider,
  message,
  onRetry,
  retrying: retryingProp,
}: {
  provider?: string | null;
  message: string;
  onRetry?: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const [retryingLocal, setRetryingLocal] = useState(false);
  const retrying = retryingProp ?? retryingLocal;

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetryingLocal(true);
    try {
      await onRetry();
    } finally {
      setRetryingLocal(false);
    }
  };

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 max-w-full overflow-hidden">
      <div className="flex items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-destructive min-w-0">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>Error from {runtimeDisplayName(provider)}</span>
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1"
          >
            {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
            Retry
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-destructive/90 wrap-anywhere whitespace-pre-wrap">{message}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        This came from the agent runtime on your machine, not from Alook.
      </p>
    </div>
  );
}
