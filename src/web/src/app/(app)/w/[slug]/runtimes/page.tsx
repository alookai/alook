"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
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
import { Loader2, Monitor, Plus } from "lucide-react";
import type { Runtime } from "@/lib/api";
import { CLI_CMD } from "@/lib/utils";

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
  const { runtimes, loading, handleGenerateToken, handleDeleteMachine, reload } =
    useAgentContext();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDescription, setConfirmDescription] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const confirmAction = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-open "New machine" sheet when navigated with ?connect
  useEffect(() => {
    if (searchParams.has("connect")) {
      setSheetOpen(true);
      router.replace(pathname, { scroll: false });
    }
  }, [searchParams, router, pathname]);

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

  // Group runtimes by machine
  const machines = new Map<
    string,
    { deviceInfo: string; name: string; runtimes: Runtime[] }
  >();
  for (const rt of runtimes) {
    const key = rt.daemon_id || rt.id;
    if (!machines.has(key)) {
      machines.set(key, {
        deviceInfo: typeof rt.device_info === "string" ? rt.device_info : "",
        name: rt.name || "",
        runtimes: [],
      });
    }
    machines.get(key)!.runtimes.push(rt);
  }

  if (loading) {
    return (
      <>
        {/* Skeleton title bar */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-2.5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-8 w-[116px] rounded-md" />
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
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-2.5">
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
          <div className="flex flex-1 items-center justify-center py-12">
            <div className="text-center animate-[fade-up_400ms_ease-out_both]">
              <p className="text-muted-foreground text-sm">
                No machines connected.
              </p>
              <p className="text-xs text-muted-foreground mt-2 max-w-xs mx-auto">
                Connect a machine to start running agents locally.
              </p>
              <Button
                size="sm"
                className="mt-5"
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
                machine.deviceInfo || machine.name || daemonId;
              return (
                <Card key={daemonId} size="sm" className="group">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Monitor className="size-4 text-muted-foreground shrink-0" />
                      <CardTitle className="truncate">
                        {displayName}
                      </CardTitle>
                    </div>
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground h-6 px-2 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
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
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {machine.runtimes.map((runtime) => (
                        <div
                          key={runtime.id}
                          className="flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-medium truncate">
                              {runtime.provider}
                              {runtime.metadata?.version ? (
                                <span className="ml-1.5 font-normal text-muted-foreground">
                                  {String(runtime.metadata.version)}
                                </span>
                              ) : null}
                            </p>
                            <p className="text-xs text-muted-foreground tabular-nums">
                              {runtime.last_seen_at ? new Date(
                                runtime.last_seen_at
                              ).toLocaleString() : "Never"}
                            </p>
                          </div>
                          <Badge
                            variant={
                              runtime.status === "online"
                                ? "default"
                                : "outline"
                            }
                            className="shrink-0"
                          >
                            {runtime.status}
                          </Badge>
                        </div>
                      ))}
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
        <SheetContent className="data-[side=right]:inset-y-2 data-[side=right]:right-2 data-[side=right]:h-auto data-[side=right]:rounded-xl data-[side=right]:border data-[side=right]:border-l">
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
