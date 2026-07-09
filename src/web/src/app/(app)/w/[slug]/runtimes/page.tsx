"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Monitor, Plus } from "lucide-react";

import type { AgentRuntime as Runtime } from "@alook/shared";
import { semverGte, isTauri, isDesktop, tauriInvoke } from "@alook/shared";
import { cliCmd, getAppMode } from "@/lib/utils";
import { ProviderLogo } from "@/components/provider-logo";
import { triggerRuntimeUpdate, triggerRuntimeRescan, fetchLatestCliVersion } from "@/lib/api";
import { Loader2, RefreshCw } from "lucide-react";

import { ConnectMachineSteps } from "@/components/connect-machine-steps";
import { trackRuntimeConnected } from "@/lib/analytics";

export default function RuntimesPage() {
  const { agents, runtimes, loading, handleGenerateToken, handleDeleteMachine, subscribeWs, workspaceId } =
    useAgentContext();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const mode = getAppMode();
  const isMobileApp = mode === "mobile";
  const isTauriDesktop = isTauri() && isDesktop();
  const hideNewMachine = isMobileApp || isTauriDesktop;

  const [sheetOpen, setSheetOpen] = useState(() => searchParams.has("connect"));
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);
  const [registeredDaemonId, setRegisteredDaemonId] = useState<string | null>(null);
  const [daemonOnline, setDaemonOnline] = useState(false);

  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null);
  const [updatingDaemons, setUpdatingDaemons] = useState<Set<string>>(new Set());
  const [rescanningDaemons, setRescanningDaemons] = useState<Set<string>>(new Set());

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDescription, setConfirmDescription] = useState("");
  const [confirmLabel, setConfirmLabel] = useState("Remove");
  const [confirmLoadingLabel, setConfirmLoadingLabel] = useState<string | undefined>(undefined);
  const [confirmVariant, setConfirmVariant] = useState<"destructive" | "default">("destructive");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const confirmAction = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    fetchLatestCliVersion()
      .then((data) => setLatestCliVersion(data.version))
      .catch(() => {});
  }, []);

  // Clean up ?connect query param after initial open
  useEffect(() => {
    if (searchParams.has("connect")) {
      router.replace(pathname, { scroll: false });
    }
  }, [searchParams, router, pathname]);

  // Listen for registration + online events while the sheet is open.
  const sheetOpenRef = useRef(sheetOpen);
  useEffect(() => { sheetOpenRef.current = sheetOpen; }, [sheetOpen]);
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  const registeredDaemonIdRef = useRef(registeredDaemonId);
  useEffect(() => { registeredDaemonIdRef.current = registeredDaemonId; }, [registeredDaemonId]);
  useEffect(() => {
    return subscribeWs((msg) => {
      if (!sheetOpenRef.current) return;
      if (msg.type === "runtime.registered" && msg.workspaceId === workspaceId) {
        setRegisteredDaemonId(msg.daemonId);
      }
      if (
        msg.type === "runtime.status" &&
        msg.workspaceId === workspaceId &&
        msg.status === "online" &&
        registeredDaemonIdRef.current &&
        msg.daemonId === registeredDaemonIdRef.current
      ) {
        trackRuntimeConnected({ runtime_type: "desktop" });
        setSheetOpen(false);
        setGeneratedToken("");
        setRegisteredDaemonId(null);
        setDaemonOnline(false);
        toast.success("Machine connected");
        if (agentsRef.current.length === 0) {
          const slug = pathname.split("/")[2];
          router.push(`/w/${slug}/agents/new`);
        }
      }
    });
  }, [subscribeWs, workspaceId, pathname, router]);

  const openConfirm = (
    title: string,
    description: string,
    action: () => Promise<void>,
    opts?: { label?: string; loadingLabel?: string; variant?: "destructive" | "default" }
  ) => {
    setConfirmTitle(title);
    setConfirmDescription(description);
    setConfirmLabel(opts?.label ?? "Remove");
    setConfirmLoadingLabel(opts?.loadingLabel);
    setConfirmVariant(opts?.variant ?? "destructive");
    confirmAction.current = action;
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (!confirmAction.current) return;
    setConfirmLoading(true);
    try {
      await confirmAction.current();
    } finally {
      setConfirmLoading(false);
      setConfirmOpen(false);
      confirmAction.current = null;
    }
  };

  const onGenerateToken = useCallback(async () => {
    setGeneratingToken(true);
    try {
      const token = await handleGenerateToken();
      if (token) setGeneratedToken(token);
    } finally {
      setGeneratingToken(false);
    }
  }, [handleGenerateToken]);

  const handleUpdate = async (runtimeId: string, daemonId: string) => {
    setUpdatingDaemons((prev) => new Set(prev).add(daemonId));
    try {
      await triggerRuntimeUpdate(runtimeId, workspaceId);
      toast.success("Update triggered");
    } catch {
      toast.error("Failed to trigger update");
      setUpdatingDaemons((prev) => {
        const next = new Set(prev);
        next.delete(daemonId);
        return next;
      });
    }
  };

  const handleRescan = async (runtimeId: string, daemonId: string) => {
    setRescanningDaemons((prev) => new Set(prev).add(daemonId));
    try {
      await triggerRuntimeRescan(runtimeId, workspaceId);
      toast.success("Rescan triggered — daemon will restart to detect runtimes");
    } catch {
      toast.error("Failed to trigger rescan");
      setRescanningDaemons((prev) => {
        const next = new Set(prev);
        next.delete(daemonId);
        return next;
      });
    }
  };

  // Derive effective optimistic sets: clear once server-side flag is gone AND runtime refreshed
  const effectiveUpdatingDaemons = useMemo(() => {
    if (updatingDaemons.size === 0) return updatingDaemons;
    const still = new Set<string>();
    for (const id of updatingDaemons) {
      const rt = runtimes.find((r) => (r.daemon_id || r.id) === id);
      // Keep optimistic state until runtime data confirms update is done (flag cleared)
      if (!rt || rt.pending_update_version) {
        still.add(id);
      }
    }
    return still;
  }, [runtimes, updatingDaemons]);

  const effectiveRescanningDaemons = useMemo(() => {
    if (rescanningDaemons.size === 0) return rescanningDaemons;
    const still = new Set<string>();
    for (const rt of runtimes) {
      const key = rt.daemon_id || rt.id;
      if (rescanningDaemons.has(key) && rt.pending_rescan) {
        still.add(key);
      }
    }
    return still;
  }, [runtimes, rescanningDaemons]);

  // Group runtimes by machine
  const machines = new Map<
    string,
    { deviceInfo: string; status: string; lastSeenAt: string | null; pendingUpdateVersion: string | null; pendingRescan: boolean; cliVersion: string | null; runtimes: Runtime[] }
  >();
  for (const rt of runtimes) {
    const key = rt.daemon_id || rt.id;
    if (!machines.has(key)) {
      const meta = rt.metadata as Record<string, unknown> | null;
      machines.set(key, {
        deviceInfo: typeof rt.device_info === "string" ? rt.device_info : "",
        status: rt.status,
        lastSeenAt: rt.last_seen_at,
        pendingUpdateVersion: rt.pending_update_version ?? null,
        pendingRescan: !!rt.pending_rescan,
        cliVersion: (meta?.cli_version as string) ?? null,
        runtimes: [],
      });
    }
    machines.get(key)!.runtimes.push(rt);
  }

  if (loading) {
    return (
      <>
        {/* Skeleton title bar */}
        <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2">
          <div className="flex items-center gap-3">

            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-8 w-29 rounded-md" />
        </div>
        {/* Skeleton card grid */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border/50 bg-card p-4 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <Skeleton className="size-4 rounded" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                    <Skeleton className="h-5 w-14 rounded-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-medium">Runtimes</h1>
          <p className="text-xs text-muted-foreground">
            Your machines and their agent runtimes.
          </p>
        </div>
        {!hideNewMachine && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setGeneratedToken("");
              setRegisteredDaemonId(null);
              setSheetOpen(true);
            }}
            disabled={generatingToken}
          >
            <Plus className="size-3.5" />
            New machine
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {runtimes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center min-h-[60vh]">
            <div className="text-center animate-[fade-up_400ms_ease-out_both]">
              <p className="text-muted-foreground text-sm">
                {hideNewMachine
                  ? "No machines connected. Use the desktop app or CLI to connect a machine."
                  : "Connect a machine to start running agents locally."}
              </p>
              {!hideNewMachine && (
                <Button
                  size="sm"
                  className="mt-4 glow-border"
                  onClick={() => {
                    setGeneratedToken("");
                    setSheetOpen(true);
                  }}
                >
                  Connect Machine
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from(machines.entries()).map(([daemonId, machine]) => {
              const displayName =
                machine.deviceInfo || daemonId;
              return (
                <Card key={daemonId} size="sm">
                  <CardHeader>
                    <div className="flex items-center gap-2 min-w-0">
                      <Monitor className="size-4 text-muted-foreground shrink-0" />
                      <CardTitle className="truncate">
                        {displayName}
                      </CardTitle>
                      {machine.cliVersion && (
                        <span className="text-xs text-muted-foreground/60 shrink-0">v{machine.cliVersion}</span>
                      )}
                      <Badge
                        variant={
                          machine.status === "online"
                            ? "default"
                            : "outline"
                        }
                        className="shrink-0"
                      >
                        {machine.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {machine.lastSeenAt ? new Date(
                            machine.lastSeenAt
                          ).toLocaleString() : "Never seen"}
                        </span>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const isUpdating = !!machine.pendingUpdateVersion || effectiveUpdatingDaemons.has(daemonId);
                            const needsUpdate = machine.status === "online" && latestCliVersion && (!machine.cliVersion || !semverGte(machine.cliVersion, latestCliVersion));
                            if (isUpdating) {
                              return (
                                <Button variant="ghost" size="sm" disabled className="text-xs h-6 px-2">
                                  <Loader2 className="size-3 animate-spin mr-1" />
                                  Updating...
                                </Button>
                              );
                            }
                            if (needsUpdate) {
                              return (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs h-6 px-2"
                                  onClick={() => openConfirm(
                                    "Update daemon",
                                    `This will update the daemon on "${displayName}" to the latest CLI version. The daemon will restart during the update.`,
                                    async () => { await handleUpdate(machine.runtimes[0].id, daemonId); },
                                    { label: "Update", loadingLabel: "Updating...", variant: "default" }
                                  )}
                                >
                                  Update
                                </Button>
                              );
                            }
                            return null;
                          })()}
                          {(() => {
                            const isRescanning = machine.pendingRescan || effectiveRescanningDaemons.has(daemonId);
                            if (machine.status !== "online") return null;
                            if (isRescanning) {
                              return (
                                <Button variant="ghost" size="sm" disabled className="text-xs h-6 px-2">
                                  <RefreshCw className="size-3 animate-spin mr-1" />
                                  Rescanning...
                                </Button>
                              );
                            }
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs h-6 px-2"
                                onClick={() => openConfirm(
                                  "Rescan runtimes",
                                  `This will restart the daemon on "${displayName}" to re-detect available runtimes (Claude Code, Codex, OpenCode).`,
                                  async () => { await handleRescan(machine.runtimes[0].id, daemonId); },
                                  { label: "Rescan", loadingLabel: "Triggering...", variant: "default" }
                                )}
                              >
                                <RefreshCw className="size-3 mr-1" />
                                Rescan
                              </Button>
                            );
                          })()}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-muted-foreground h-6 px-2 hover:text-destructive"
                            onClick={() => {
                              openConfirm(
                                "Remove machine",
                                `This will remove "${displayName}" and all its runtimes. Agents using these runtimes will be unlinked.`,
                                async () => {
                                  await handleDeleteMachine(daemonId);
                                }
                              );
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {machine.runtimes.map((runtime) => (
                          <Badge
                            key={runtime.id}
                            variant="secondary"
                            className="gap-2"
                          >
                            <ProviderLogo provider={runtime.provider} className="h-3.5 w-3.5" />
                            {runtime.provider}
                            {runtime.metadata?.version ? (
                              <span className="text-muted-foreground font-normal">
                                {String(runtime.metadata.version)}
                              </span>
                            ) : null}
                          </Badge>
                        ))}
                      </div>
                      {machine.status !== "online" && (
                        <div className="pt-1.5 border-t border-border/50">
                          <p className="text-[11px] text-muted-foreground mb-2">
                            Bring this machine online:
                          </p>
                          {mode === "desktop" && isTauri() ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full h-7 text-[11px]"
                              onClick={async () => {
                                try {
                                  await tauriInvoke("daemon_start");
                                  toast.success("Daemon started");
                                } catch {
                                  toast.error("Failed to start daemon");
                                }
                              }}
                            >
                              Start Daemon
                            </Button>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <div
                                    className="relative overflow-hidden rounded-md bg-muted px-2 py-2 font-mono text-[11px] text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
                                    onClick={() => {
                                      navigator.clipboard.writeText(`${cliCmd()} daemon start`);
                                      toast.success("Copied to clipboard");
                                    }}
                                  />
                                }
                              >
                                <span className="absolute inset-0 -translate-x-full animate-[shimmer_2.5s_infinite] bg-linear-to-r from-transparent via-(--shimmer-peak) to-transparent" />
                                <span className="relative">{cliCmd()} daemon start</span>
                              </TooltipTrigger>
                              <TooltipContent>Click to copy</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Connect machine sheet */}
      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setGeneratedToken("");
          }
        }}
      >
        <SheetContent className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border">
          <SheetHeader>
            <SheetTitle>Connect a machine</SheetTitle>
            <SheetDescription>
              Your machine runs AI agents locally using Claude Code, Codex, or
              OpenCode.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <ConnectMachineSteps
              generatedToken={generatedToken}
              generatingToken={generatingToken}
              onGenerateToken={onGenerateToken}
              registered={!!registeredDaemonId}
              daemonOnline={daemonOnline}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={confirmLabel}
        loadingLabel={confirmLoadingLabel}
        confirmVariant={confirmVariant}
        loading={confirmLoading}
        onConfirm={handleConfirm}
      />
    </>
  );
}
