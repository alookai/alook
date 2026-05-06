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
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Monitor, Plus } from "lucide-react";

import type { AgentRuntime as Runtime } from "@alook/shared";
import { semverGte } from "@alook/shared";
import { CLI_CMD } from "@/lib/utils";
import { ProviderLogo } from "@/components/provider-logo";
import { triggerRuntimeUpdate, triggerRuntimeRescan, fetchLatestCliVersion } from "@/lib/api";
import { Loader2, RefreshCw } from "lucide-react";

function ConnectMachineSteps({
  generatedToken,
  generatingToken,
  onGenerateToken,
}: {
  generatedToken: string;
  generatingToken: boolean;
  onGenerateToken: () => void;
}) {
  const hasTriggered = useRef(false);
  useEffect(() => {
    if (!generatedToken && !generatingToken && !hasTriggered.current) {
      hasTriggered.current = true;
      onGenerateToken();
    }
  }, [generatedToken, generatingToken, onGenerateToken]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="space-y-6">
      {/* Step 1 */}
      <div className="space-y-2">
        <p className="text-xs font-medium flex items-center gap-2">
          <span className="flex items-center justify-center size-5 rounded-full bg-foreground text-background text-[10px] font-semibold">
            1
          </span>
          Register your CLI
        </p>
        <p className="text-xs text-muted-foreground pl-7">
          Run this in your terminal to link your machine.
        </p>
        {generatingToken ? (
          <div className="pl-7">
            <div className="rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground animate-pulse">
              Generating token...
            </div>
          </div>
        ) : generatedToken ? (
          <div className="pl-7 space-y-2">
            <div
              className="rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
              onClick={() =>
                copyToClipboard(
                  `${CLI_CMD} register --token ${generatedToken}`
                )
              }
              title="Click to copy"
            >
              {CLI_CMD} register --token{" "}
              <span className="text-foreground/70">
                {generatedToken.slice(0, 12)}...
              </span>
            </div>
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(
                  `${CLI_CMD} register --token ${generatedToken}`
                );
                toast.success("Copied to clipboard");
              }}
              className="w-full"
            >
              Copy Command
            </Button>
          </div>
        ) : null}
      </div>

      {/* Step 2 */}
      <div
        className={`space-y-2 ${!generatedToken ? "opacity-40 pointer-events-none" : ""}`}
      >
        <p className="text-xs font-medium flex items-center gap-2">
          <span className="flex items-center justify-center size-5 rounded-full bg-foreground text-background text-[10px] font-semibold">
            2
          </span>
          Start the daemon
        </p>
        <p className="text-xs text-muted-foreground pl-7">
          The daemon connects your local agents to Alook.
        </p>
        <div
          className="ml-7 rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
          onClick={() =>
            copyToClipboard(`${CLI_CMD} daemon start --foreground`)
          }
          title="Click to copy"
        >
          {CLI_CMD} daemon start --foreground
        </div>
      </div>

    </div>
  );
}

export default function RuntimesPage() {
  const { runtimes, loading, handleGenerateToken, handleDeleteMachine, subscribeWs, workspaceId } =
    useAgentContext();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [sheetOpen, setSheetOpen] = useState(() => searchParams.has("connect"));
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);

  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null);
  const [updatingDaemons, setUpdatingDaemons] = useState<Set<string>>(new Set());
  const [rescanningDaemons, setRescanningDaemons] = useState<Set<string>>(new Set());

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDescription, setConfirmDescription] = useState("");
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

  // Close the sheet only after the daemon is actually online. Runtime
  // registration can happen before the user starts the daemon process.
  useEffect(() => {
    return subscribeWs((msg) => {
      if (
        msg.type === "runtime.status" &&
        msg.workspaceId === workspaceId &&
        msg.status === "online"
      ) {
        setSheetOpen(false);
        setGeneratedToken("");
        toast.success("Machine connected");
      }
    });
  }, [subscribeWs, workspaceId]);

  const openConfirm = (
    title: string,
    description: string,
    action: () => Promise<void>
  ) => {
    setConfirmTitle(title);
    setConfirmDescription(description);
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

  // Derive effective optimistic sets: filter out entries whose server-side flag has cleared
  const effectiveUpdatingDaemons = useMemo(() => {
    if (updatingDaemons.size === 0) return updatingDaemons;
    const still = new Set<string>();
    for (const rt of runtimes) {
      const key = rt.daemon_id || rt.id;
      if (updatingDaemons.has(key) && rt.pending_update_version) {
        still.add(key);
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
        <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5">
          <div className="flex items-center gap-3">

            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-8 w-29 rounded-md" />
        </div>
        {/* Skeleton card grid */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-medium">Runtimes</h1>
          <p className="text-xs text-muted-foreground">
            Your machines and their agent runtimes.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setGeneratedToken("");
            setSheetOpen(true);
          }}
          disabled={generatingToken}
        >
          <Plus className="size-3.5" />
          New machine
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {runtimes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center min-h-[60vh]">
            <div className="text-center animate-[fade-up_400ms_ease-out_both]">
              <p className="text-muted-foreground text-sm">
                Connect a machine to start running agents locally.
              </p>
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
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {machine.lastSeenAt ? new Date(
                            machine.lastSeenAt
                          ).toLocaleString() : "Never seen"}
                        </span>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const isUpdating = !!machine.pendingUpdateVersion || effectiveUpdatingDaemons.has(daemonId);
                            const needsUpdate = latestCliVersion && (!machine.cliVersion || !semverGte(machine.cliVersion, latestCliVersion));
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
                                  onClick={() => handleUpdate(machine.runtimes[0].id, daemonId)}
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
                                onClick={() => handleRescan(machine.runtimes[0].id, daemonId)}
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
                      <div className="flex flex-wrap gap-1.5">
                        {machine.runtimes.map((runtime) => (
                          <Badge
                            key={runtime.id}
                            variant="secondary"
                            className="gap-1.5"
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
                          <p className="text-[11px] text-muted-foreground mb-1.5">
                            Bring this machine online:
                          </p>
                          <div
                            className="relative overflow-hidden rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
                            onClick={() => {
                              navigator.clipboard.writeText(`${CLI_CMD} daemon start`);
                              toast.success("Copied to clipboard");
                            }}
                            title="Click to copy"
                          >
                            <span className="absolute inset-0 -translate-x-full animate-[shimmer_2.5s_infinite] bg-linear-to-r from-transparent via-(--shimmer-peak) to-transparent" />
                            <span className="relative">{CLI_CMD} daemon start</span>
                          </div>
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
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={confirmTitle}
        description={confirmDescription}
        loading={confirmLoading}
        onConfirm={handleConfirm}
      />
    </>
  );
}
