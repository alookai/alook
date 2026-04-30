"use client";

import { useEffect, useState } from "react";
import { useAgentContext } from "@/contexts/agent-context";
import { getMinCliVersion, triggerRuntimeUpdate } from "@/lib/api";
import { semverGte } from "@alook/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { AgentRuntime } from "@alook/shared";

export function RuntimeVersionGate() {
  const { runtimes, workspaceId } = useAgentContext();
  const [minVersion, setMinVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  useEffect(() => {
    getMinCliVersion().then((res) => setMinVersion(res.min_cli_version)).catch(() => {});
  }, []);

  if (!minVersion) return null;

  const outdatedRuntimes = runtimes.filter((rt) => {
    if (rt.status !== "online") return false;
    const cliVersion = (rt.metadata as Record<string, unknown>)?.cli_version;
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
    setUpdating((prev) => new Set(prev).add(rt.id));
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
            The following machine(s) are running an outdated CLI version (minimum required: v{minVersion}). Please update to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {[...outdatedMachines.entries()].map(([daemonId, rt]) => {
            const cliVersion = (rt.metadata as Record<string, unknown>)?.cli_version as string | undefined;
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
      </DialogContent>
    </Dialog>
  );
}
