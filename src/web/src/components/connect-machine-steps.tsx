"use client";

import { useRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check, Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cliCmd, getAppMode } from "@/lib/utils";
import { isTauri, tauriInvoke } from "@alook/shared";

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
  const [executing, setExecuting] = useState(false);
  const [cliPrefix, setCliPrefix] = useState<string | null>(null);

  const connected = registered && daemonOnline;

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

  const command = `${cliCmd()} register --token ${generatedToken}`;

  const copyRegister = () => {
    navigator.clipboard.writeText(command);
    toast.success("Copied to clipboard");
  };

  const executeRegister = async () => {
    if (!isTauri()) return;
    setExecuting(true);
    try {
      const result = await tauriInvoke<{ success: boolean; message: string }>("register_cli", { token: generatedToken });
      if (result.success) {
        toast.success("Registered successfully");
      } else {
        toast.error(result.message || "Registration failed");
      }
    } catch {
      toast.error("Failed to execute registration");
    } finally {
      setExecuting(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-600">
        <Check className="size-4" />
        Computer connected
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Connect a computer</p>
      <p className="text-xs text-muted-foreground">
        {isDesktopApp
          ? "Click to register your machine with Alook."
          : "Run this in your terminal to link your machine."}
      </p>
      {generatingToken ? (
        <div className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground animate-pulse">
          Generating token...
        </div>
      ) : generatedToken ? (
        <div className="space-y-2">
          {isDesktopApp ? (
            <Button
              size="sm"
              onClick={executeRegister}
              disabled={executing}
              className="w-full"
              title={cliPrefix ? `${cliPrefix} register --token <token>` : undefined}
            >
              {executing ? (
                <><Loader2 className="size-3 animate-spin mr-1" /> Registering...</>
              ) : (
                <><Play className="size-3 mr-1" /> Register</>
              )}
            </Button>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div
                      className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-muted/80 transition-colors break-all"
                      onClick={copyRegister}
                    />
                  }
                >
                  {command}
                </TooltipTrigger>
                <TooltipContent>Click to copy</TooltipContent>
              </Tooltip>
              <Button size="sm" onClick={copyRegister} className="w-full">
                Copy Command
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
