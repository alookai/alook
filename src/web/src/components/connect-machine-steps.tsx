"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { cliCmd, daemonStartCmd } from "@/lib/utils";

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

  const daemonCmd = daemonStartCmd();

  const copyDaemon = () => {
    navigator.clipboard.writeText(daemonCmd);
    toast.success("Copied to clipboard");
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
            {!registered && (
              <Button
                size="sm"
                onClick={copyRegister}
                className="w-full"
              >
                Copy Command
              </Button>
            )}
          </div>
        ) : null}
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
        <p className="text-xs text-muted-foreground pl-7">
          The daemon connects your local agents to Alook.
        </p>
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
        {registered && !daemonOnline && (
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
      </div>
    </div>
  );
}
