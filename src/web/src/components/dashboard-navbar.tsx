"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  listRuntimes,
  createMachineToken,
  deleteMachine,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Logo } from "@/components/logo";
import { toast } from "sonner";
import type { AgentRuntime as Runtime } from "@alook/shared";
import { signOut } from "@/lib/auth-client";
import { CLI_CMD } from "@/lib/utils";
import { ProviderLogo } from "@/components/provider-logo";

function OnboardingSteps({
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
      <div>
        <p className="text-sm font-medium tracking-tight">
          Connect a machine
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Your machine runs AI agents locally using Claude Code, Codex, or
          OpenCode.
        </p>
      </div>

      {/* Step 1 — Register CLI */}
      <div className="space-y-2">
        <p className="text-xs font-medium flex items-center gap-2">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-foreground text-background text-[10px] font-semibold">
            1
          </span>
          Register your CLI
        </p>
        <p className="text-[11px] text-muted-foreground pl-7">
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

      {/* Step 2 — Start daemon */}
      <div
        className={`space-y-2 ${!generatedToken ? "opacity-40 pointer-events-none" : ""}`}
      >
        <p className="text-xs font-medium flex items-center gap-2">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-foreground text-background text-[10px] font-semibold">
            2
          </span>
          Start the daemon
        </p>
        <p className="text-[11px] text-muted-foreground pl-7">
          The daemon connects your local agents to Alook.
        </p>
        <div
          className="ml-7 rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
          onClick={() =>
            copyToClipboard(process.env.NODE_ENV === "development"
              ? `${CLI_CMD} daemon start --foreground`
              : `${CLI_CMD} daemon start`)
          }
          title="Click to copy"
        >
          {CLI_CMD} daemon start{process.env.NODE_ENV === "development" ? " --foreground" : ""}
        </div>
      </div>
    </div>
  );
}

export function DashboardNavbar() {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [runtimeSheetOpen, setRuntimeSheetOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  // Confirm dialog state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDescription, setConfirmDescription] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const confirmAction = useRef<(() => Promise<void>) | null>(null);

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

  // NOTE: This component is currently unused. The workspaceId is hardcoded
  // as a placeholder — if this component is revived it needs a workspace prop.
  const workspaceId = ""
  const loadRuntimes = useCallback(async () => {
    if (!workspaceId) return
    try {
      const r = await listRuntimes(workspaceId);
      setRuntimes(r);
    } catch {
      // silent — runtimes are supplementary
    }
  }, [workspaceId]);

  useEffect(() => {
    loadRuntimes();
  }, [loadRuntimes]);

  const handleGenerateToken = async () => {
    setGeneratingToken(true);
    setTokenCopied(false);
    try {
      const res = await createMachineToken("cli", workspaceId);
      setGeneratedToken(res.token);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to generate token"
      );
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleCopyToken = async () => {
    await navigator.clipboard.writeText(generatedToken);
    setTokenCopied(true);
    toast.success("Copied to clipboard");
  };

  return (
    <>
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Logo />

          <div className="flex items-center gap-1.5">
            <Sheet
              open={runtimeSheetOpen}
              onOpenChange={(open) => {
                setRuntimeSheetOpen(open);
                if (open) loadRuntimes();
                if (!open) {
                  setGeneratedToken("");
                  setTokenCopied(false);
                }
              }}
            >
              <SheetTrigger render={<Button variant="outline" size="sm" />}>
                Runtimes
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Runtimes</SheetTitle>
                  <SheetDescription>
                    Your machines and their agent runtimes.
                  </SheetDescription>
                </SheetHeader>
                <SheetBody>
                  {runtimes.length === 0 ? (
                    <OnboardingSteps
                      generatedToken={generatedToken}
                      generatingToken={generatingToken}
                      onGenerateToken={handleGenerateToken}
                    />
                  ) : (
                    <div className="space-y-3">
                      {(() => {
                        const machines = new Map<
                          string,
                          { deviceInfo: string; runtimes: Runtime[] }
                        >();
                        for (const rt of runtimes) {
                          const key = rt.daemon_id || rt.id;
                          if (!machines.has(key)) {
                            machines.set(key, {
                              deviceInfo:
                                typeof rt.device_info === "string"
                                  ? rt.device_info
                                  : "",
                              runtimes: [],
                            });
                          }
                          machines.get(key)!.runtimes.push(rt);
                        }

                        return Array.from(machines.entries()).map(
                          ([daemonId, machine]) => {
                            const displayName =
                              machine.deviceInfo || daemonId;

                            return (
                              <div
                                key={daemonId}
                                className="group rounded-lg border p-3.5 space-y-3"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium tracking-tight">
                                    {displayName}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-[11px] text-muted-foreground h-6 px-2 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={() => {
                                      openConfirm(
                                        "Remove machine",
                                        `This will remove "${displayName}" and all its runtimes. Agents using these runtimes will be unlinked.`,
                                        async () => {
                                          try {
                                            await deleteMachine(daemonId, workspaceId);
                                            const r = await listRuntimes(workspaceId);
                                            setRuntimes(r);
                                          } catch (err) {
                                            toast.error(
                                              err instanceof Error
                                                ? err.message
                                                : "Failed to remove machine"
                                            );
                                          }
                                        }
                                      );
                                    }}
                                  >
                                    Remove
                                  </Button>
                                </div>

                                <div className="space-y-2 pl-0.5">
                                  {machine.runtimes.map((runtime) => (
                                    <div
                                      key={runtime.id}
                                      className="rounded-md border border-dashed p-2.5 space-y-1"
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium flex items-center gap-1.5">
                                          <ProviderLogo provider={runtime.provider} className="h-3.5 w-3.5" />
                                          {runtime.provider}
                                          {runtime.metadata?.version ? (
                                            <span className="ml-1.5 font-normal text-muted-foreground">
                                              {String(runtime.metadata.version)}
                                            </span>
                                          ) : null}
                                        </span>
                                        <Badge
                                          variant={
                                            runtime.status === "online"
                                              ? "default"
                                              : "outline"
                                          }
                                          className="text-[10px] px-1.5 py-0"
                                        >
                                          {runtime.status}
                                        </Badge>
                                      </div>
                                      <p className="text-[11px] text-muted-foreground tabular-nums">
                                        Last seen{" "}
                                        {runtime.last_seen_at ? new Date(
                                          runtime.last_seen_at
                                        ).toLocaleString() : "Never"}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                        );
                      })()}

                      <div className="pt-3 border-t">
                        {generatedToken ? (
                          <div className="space-y-2">
                            <div className="rounded-md bg-muted p-2.5 font-mono text-xs break-all select-all">
                              {generatedToken}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              Copy this token now — it won&apos;t be shown again.
                            </p>
                            <Button
                              size="sm"
                              onClick={handleCopyToken}
                              className="w-full"
                            >
                              {tokenCopied ? "Copied!" : "Copy Token"}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleGenerateToken}
                            disabled={generatingToken}
                            className="w-full text-xs text-muted-foreground"
                          >
                            {generatingToken
                              ? "Generating..."
                              : "Connect new machine"}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </SheetBody>
              </SheetContent>
            </Sheet>

            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
              }}
            >
              Sign Out
            </Button>
          </div>
        </div>
      </header>

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
