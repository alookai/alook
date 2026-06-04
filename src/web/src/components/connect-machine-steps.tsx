"use client";

import { useRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check, Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cliCmd, daemonStartCmd, getAppMode } from "@/lib/utils";
import { isTauri, tauriInvoke } from "@alook/shared";

function StepIndicator({ step, completed }: { step: number; completed: boolean }) {
  if (completed) {
    return (
      <span className="flex items-center justify-center size-5 rounded-full bg-emerald-500 text-white transition-all duration-300">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span className="flex items-center justify-center size-5 rounded-full bg-foreground text-background text-xs font-semibold">
      {step}
    </span>
  );
}

export function ConnectMachineSteps({
  generatedToken,
  generatingToken,
  onGenerateToken,
  registered,
  daemonOnline,
}: {
  generatedToken: string;
  generatingToken: boolean;
  onGenerateToken: () => void;
  registered: boolean;
  daemonOnline: boolean;
}) {
  const hasTriggered = useRef(false);
  const mode = getAppMode();
  const isDesktopApp = mode === "desktop";
  const [executing, setExecuting] = useState<"register" | "daemon" | null>(null);
  const [cliPrefix, setCliPrefix] = useState<string | null>(null);

  useEffect(() => {
    if (isDesktopApp && isTauri()) {
      tauriInvoke<{ command: string; is_dev: boolean }>("get_cli_info")
        .then((info) => setCliPrefix(info.command))
        .catch(() => {});
    }
  }, [isDesktopApp]);

  useEffect(() => {
    if (!generatedToken && !generatingToken && !hasTriggered.current) {
      hasTriggered.current = true;
      onGenerateToken();
    }
  }, [generatedToken, generatingToken, onGenerateToken]);

  const copyRegister = () => {
    navigator.clipboard.writeText(`${cliCmd()} register --token ${generatedToken}`);
    toast.success("Copied to clipboard");
  };

  const executeRegister = async () => {
    if (!isTauri()) return;
    setExecuting("register");
    try {
      const result = await tauriInvoke<{ success: boolean; message: string }>("register_cli", { token: generatedToken });
      if (result.success) {
        toast.success("CLI registered successfully");
      } else {
        toast.error(result.message || "Registration failed");
      }
    } catch {
      toast.error("Failed to execute registration");
    } finally {
      setExecuting(null);
    }
  };

  const daemonCmd = daemonStartCmd();

  const copyDaemon = () => {
    navigator.clipboard.writeText(daemonCmd);
    toast.success("Copied to clipboard");
  };

  const executeDaemonStart = async () => {
    if (!isTauri()) return;
    setExecuting("daemon");
    try {
      const result = await tauriInvoke<{ success: boolean; message: string }>("daemon_start");
      if (result.success) {
        toast.success("Daemon started");
      } else {
        toast.error(result.message || "Failed to start daemon");
      }
    } catch {
      toast.error("Failed to start daemon");
    } finally {
      setExecuting(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Step 1 */}
      <div className="space-y-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <StepIndicator step={1} completed={registered} />
          Register your CLI
          {registered && <span className="text-xs text-emerald-500 font-normal">Done</span>}
        </p>
        {!registered && (
          <>
            <p className="text-xs text-muted-foreground pl-7">
              {isDesktopApp
                ? "Click to register your machine with Alook."
                : "Run this in your terminal to link your machine."}
            </p>
            {generatingToken ? (
              <div className="pl-7">
                <div className="rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground animate-pulse">
                  Generating token...
                </div>
              </div>
            ) : generatedToken ? (
              <div className="pl-7 space-y-2">
                {isDesktopApp ? (
                  <Button
                    size="sm"
                    onClick={executeRegister}
                    disabled={executing === "register"}
                    className="w-full"
                    title={cliPrefix ? `${cliPrefix} register --token <token>` : undefined}
                  >
                    {executing === "register" ? (
                      <><Loader2 className="size-3 animate-spin mr-1" /> Registering...</>
                    ) : (
                      <><Play className="size-3 mr-1" /> Register CLI</>
                    )}
                  </Button>
                ) : (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div
                            className="rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors break-all"
                            onClick={copyRegister}
                          />
                        }
                      >
                        {cliCmd()} register --token{" "}
                        <span className="text-foreground/70">
                          {generatedToken}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Click to copy</TooltipContent>
                    </Tooltip>
                    <Button
                      size="sm"
                      onClick={copyRegister}
                      className="w-full"
                    >
                      Copy Command
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Step 2 */}
      <div
        className={`space-y-2 transition-opacity duration-300 ${!registered ? "opacity-40 pointer-events-none" : ""}`}
      >
        <p className="text-sm font-medium flex items-center gap-2">
          <StepIndicator step={2} completed={daemonOnline} />
          Start the daemon
          {daemonOnline && <span className="text-xs text-emerald-500 font-normal">Done</span>}
        </p>
        {!daemonOnline && (
          <>
            <p className="text-xs text-muted-foreground pl-7">
              The daemon connects your local agents to Alook.
            </p>
            {isDesktopApp ? (
              <div className="pl-7">
                <Button
                  size="sm"
                  onClick={executeDaemonStart}
                  disabled={executing === "daemon"}
                  className="w-full"
                  title={cliPrefix ? `${cliPrefix} daemon start` : undefined}
                >
                  {executing === "daemon" ? (
                    <><Loader2 className="size-3 animate-spin mr-1" /> Starting...</>
                  ) : (
                    <><Play className="size-3 mr-1" /> Start Daemon</>
                  )}
                </Button>
              </div>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        className="ml-7 rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors"
                        onClick={copyDaemon}
                      />
                    }
                  >
                    {daemonCmd}
                  </TooltipTrigger>
                  <TooltipContent>Click to copy</TooltipContent>
                </Tooltip>
                {registered && (
                  <div className="pl-7">
                    <Button
                      size="sm"
                      onClick={copyDaemon}
                      className="w-full"
                    >
                      Copy Command
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
