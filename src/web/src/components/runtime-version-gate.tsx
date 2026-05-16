"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentContext } from "@/contexts/agent-context";
import { getMinCliVersion, triggerRuntimeUpdate } from "@/lib/api";
import { semverGte, resolveMode } from "@alook/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AlertTriangle, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import type { AgentRuntime } from "@alook/shared";

const mode = resolveMode({
  nodeEnv: process.env.NODE_ENV,
  hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
});
const MANUAL_UPDATE_CMD = mode === "app"
  ? "npx @alook/app stop && npx @alook/app@latest update && npx @alook/app start"
  : "npx @alook/cli@latest daemon stop && npx @alook/cli@latest daemon start";

export function RuntimeVersionGate() {
  const { runtimes, workspaceId } = useAgentContext();
  const [minVersion, setMinVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [showManualHint, setShowManualHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getMinCliVersion().then((res) => setMinVersion(res.min_cli_version)).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []);

  if (mode === "dev") return null;
  if (!minVersion) return null;

  const outdatedRuntimes = runtimes.filter((rt) => {
    if (rt.status !== "online") return false;
    const cliVersion = rt.metadata?.cli_version;
    if (typeof cliVersion !== "string" || !cliVersion) return true;
    return !semverGte(cliVersion, minVersion);
  });

  // Deduplicate by daemon_id — show one card per machine
  const outdatedMachines = new Map<string, AgentRuntime>();
  for (const rt of outdatedRuntimes) {
    const key = rt.daemon_id ?? rt.id;
    if (!outdatedMachines.has(key)) outdatedMachines.set(key, rt);
  }

  if (outdatedMachines.size === 0) return null;

  const handleUpdate = async (rt: AgentRuntime) => {
    if (mode === "app") {
      setShowManualHint(true);
      return;
    }
    setUpdating((prev) => new Set(prev).add(rt.id));
    if (!hintTimer.current) {
      hintTimer.current = setTimeout(() => {
        setShowManualHint(true);
      }, 5000);
    }
    try {
      await triggerRuntimeUpdate(rt.id, workspaceId);
    } catch {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(rt.id);
        return next;
      });
    }
  };

  return (
    <Dialog
      open
      modal
      disablePointerDismissal
      onOpenChange={() => {}}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" />
            Runtime Update Required
          </DialogTitle>
          <DialogDescription>
            {mode === "app"
              ? `Your local Alook app is running an outdated version (minimum required: v${minVersion}). Please update to continue.`
              : `The following machine(s) are running an outdated CLI version (minimum required: v${minVersion}). Please update to continue.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {[...outdatedMachines.entries()].map(([daemonId, rt]) => {
            const cliVersion = rt.metadata?.cli_version as string | undefined;
            const isUpdating = updating.has(rt.id);

            return (
              <div
                key={daemonId}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {rt.device_info || daemonId.slice(0, 12)}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span>v{cliVersion || "unknown"}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-500 border-amber-500/30">
                        requires v{minVersion}
                      </Badge>
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isUpdating}
                  onClick={() => handleUpdate(rt)}
                >
                  <RefreshCw className={`size-3.5 ${isUpdating ? "animate-spin" : ""}`} />
                  {isUpdating ? "Updating..." : "Update"}
                </Button>
              </div>
            );
          })}
        </div>

        {showManualHint && (
          <div className="mt-3 rounded-md bg-muted/50 border border-dashed p-2.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5 font-medium text-foreground mb-1">
              <Terminal className="size-3" />
              Update taking too long?
            </div>
            <p className="mb-1">Run this command on the machine to update manually:</p>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code
                    className="block rounded bg-background px-2 py-1 font-mono text-[11px] cursor-pointer hover:bg-background/80 transition-colors"
                    onClick={() => {
                      navigator.clipboard.writeText(MANUAL_UPDATE_CMD);
                      toast.success("Copied to clipboard");
                    }}
                  />
                }
              >
                {MANUAL_UPDATE_CMD}
              </TooltipTrigger>
              <TooltipContent>Click to copy</TooltipContent>
            </Tooltip>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
