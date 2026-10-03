"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useEffect, useCallback } from "react";
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
import { semverGte } from "@alook/shared";
import { cliCmd, getAppMode } from "@/lib/utils";
import { ProviderLogo } from "@/components/provider-logo";
import { createMachineToken } from "@/lib/api";
import { captureWorkspaceOwner, runWorkspaceRequest, useWorkspaceOwner } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { useRuntimeCommand, usePendingRuntimeCommands } from "@/hooks/workspace/use-runtime-command";
import { latestCliVersionOptions } from "@/hooks/workspace/settings-query-options";
import { Loader2, RefreshCw } from "lucide-react";

import { ConnectMachineSteps } from "@/components/connect-machine-steps";
import { trackRuntimeConnected } from "@/lib/analytics";

export default function RuntimesPage() {
  const { runtimes, loading, handleDeleteMachine, subscribeWs, workspaceId } =
    useAgentContext();
  const owner = useWorkspaceOwner();
  const pageSource = useWorkspaceViewSource(owner, "runtimes", true);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const mode = getAppMode();
  const isMobileApp = mode === "mobile";
  const hideNewMachine = isMobileApp;

  const initialSheetOpen = useMemo(() => searchParams.has("connect"), [searchParams]);
  const [sheetOpen, setSheetOpen] = useAtom(useCreateAtom(initialSheetOpen));
  const registeredDaemon = useCreateAtom<string | null>(null);
  const [registeredDaemonId, setRegisteredDaemonId] = useAtom(registeredDaemon);
  const sheetSource = useWorkspaceViewSource(owner, "runtime-pairing", sheetOpen);
  const pairing = useQuery({
    queryKey: owner.key("machine-pairing", "runtime-page", sheetOpen ? "open" : "closed"),
    enabled: false, gcTime: 0, retry: false,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => createMachineToken("cli", workspaceId, options), signal),
  });
  const generatedToken = sheetOpen ? pairing.data?.token ?? "" : "";
  const generatingToken = pairing.isFetching;
  const daemonOnline = runtimes.some((runtime) => runtime.daemon_id === registeredDaemonId && runtime.status === "online");
  const latestCliVersion = useQuery(latestCliVersionOptions(owner)).data?.version ?? null;
  const runtimeCommand = useRuntimeCommand(owner);
  const pendingCommands = usePendingRuntimeCommands(owner);
  const updatingDaemons = new Set(pendingCommands.filter((intent) => intent.kind === "update").map((intent) => runtimes.find((runtime) => runtime.id === intent.id)?.daemon_id ?? intent.id));
  const rescanningDaemons = new Set(pendingCommands.filter((intent) => intent.kind === "rescan").map((intent) => runtimes.find((runtime) => runtime.id === intent.id)?.daemon_id ?? intent.id));

  const [confirmOpen, setConfirmOpen] = useAtom(useCreateAtom(false));
  const [confirmTitle, setConfirmTitle] = useAtom(useCreateAtom(""));
  const [confirmDescription, setConfirmDescription] = useAtom(useCreateAtom(""));
  const [confirmLabel, setConfirmLabel] = useAtom(useCreateAtom("Remove"));
  const [confirmLoadingLabel, setConfirmLoadingLabel] = useAtom(useCreateAtom<string | undefined>(undefined));
  const [confirmVariant, setConfirmVariant] = useAtom(useCreateAtom<"destructive" | "default">("destructive"));
  const [confirmLoading, setConfirmLoading] = useAtom(useCreateAtom(false));
  const confirmAction = useRef<(() => Promise<void>) | null>(null);

  // Clean up ?connect query param after initial open
  useEffect(() => {
    if (searchParams.has("connect")) {
      router.replace(pathname, { scroll: false });
    }
  }, [searchParams, router, pathname]);

  // Listen for registration + online events while the sheet is open.
  useEffect(() => {
    if (!sheetOpen) return;
    const assert = sheetSource.assertActive;
    return subscribeWs((msg) => {
      try { assert(); } catch { return; }
      if (msg.type === "runtime.registered" && msg.workspaceId === workspaceId) {
        setRegisteredDaemonId(msg.daemonId);
      }
      if (
        msg.type === "runtime.status" &&
        msg.workspaceId === workspaceId &&
        msg.status === "online" &&
        registeredDaemon.get() &&
        msg.daemonId === registeredDaemon.get()
      ) {
        trackRuntimeConnected({ runtime_type: "desktop" });
        setSheetOpen(false);
        setRegisteredDaemonId(null);
        toast.success("Machine connected");
        if (owner.queryClient.getQueryData<unknown[]>(owner.key("agents"))?.length === 0) {
          router.push(`/w/${owner.slug}/agents/new`);
        }
      }
    });
  }, [subscribeWs, workspaceId, owner, router, sheetOpen, sheetSource.assertActive, registeredDaemon, setRegisteredDaemonId, setSheetOpen]);

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
    const assert = pageSource.assertActive;
    const action = confirmAction.current;
    assert();
    setConfirmLoading(true);
    try {
      await action();
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Failed to update machine");
    } finally {
      try {
        assert();
        if (confirmAction.current === action) {
          setConfirmLoading(false);
          setConfirmOpen(false);
          confirmAction.current = null;
        }
      } catch {}
    }
  };

  const onGenerateToken = useCallback(async () => {
    const assert = sheetSource.assertActive;
    try {
      assert();
      await pairing.refetch({ throwOnError: true });
      assert();
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Failed to generate token");
    }
  }, [pairing, sheetSource.assertActive]);

  const handleUpdate = async (runtimeId: string) => {
    const assert = pageSource.assertActive;
    const token = captureWorkspaceOwner(owner);
    try {
      assert();
      await runtimeCommand.mutateAsync({ kind: "update", id: runtimeId, token, assertActive: Object.assign(() => assert(), { signal: pageSource.signal }) });
      assert();
      toast.success("Update triggered");
    } catch (error) {
      try { assert(); } catch { return; }
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Failed to trigger update");
    }
  };

  const handleRescan = async (runtimeId: string) => {
    const assert = pageSource.assertActive;
    const token = captureWorkspaceOwner(owner);
    try {
      assert();
      await runtimeCommand.mutateAsync({ kind: "rescan", id: runtimeId, token, assertActive: Object.assign(() => assert(), { signal: pageSource.signal }) });
      assert();
      toast.success("Rescan triggered — daemon will restart to detect runtimes");
    } catch (error) {
      try { assert(); } catch { return; }
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Failed to trigger rescan");
    }
  };

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
        <div className="flex-1 overflow-y-auto thin-scrollbar px-4 py-4">
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

      <div className="flex-1 overflow-y-auto thin-scrollbar px-4 py-4">
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
                    setRegisteredDaemonId(null);
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
                            const isUpdating = !!machine.pendingUpdateVersion || updatingDaemons.has(daemonId);
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
                                    async () => { await handleUpdate(machine.runtimes[0].id); },
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
                            const isRescanning = machine.pendingRescan || rescanningDaemons.has(daemonId);
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
                                  async () => { await handleRescan(machine.runtimes[0].id); },
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
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <div
                                  className="relative overflow-hidden rounded-md bg-muted px-2 py-2 font-mono text-[11px] text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
                                  onClick={async () => {
                                    const assert = pageSource.assertActive;
                                    try {
                                      assert();
                                      await navigator.clipboard.writeText(`${cliCmd()} daemon start`);
                                      assert();
                                      toast.success("Copied to clipboard");
                                    } catch (error) {
                                      try { assert(); } catch { return; }
                                      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Failed to copy command");
                                    }
                                  }}
                                />
                              }
                            >
                              <span className="absolute inset-0 -translate-x-full animate-[shimmer_2.5s_infinite] bg-linear-to-r from-transparent via-(--shimmer-peak) to-transparent" />
                              <span className="relative">{cliCmd()} daemon start</span>
                            </TooltipTrigger>
                            <TooltipContent>Click to copy</TooltipContent>
                          </Tooltip>
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
          if (!open) setRegisteredDaemonId(null);
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
