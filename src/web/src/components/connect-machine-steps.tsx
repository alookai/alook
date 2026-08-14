"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { cliCmd } from "@/lib/utils";

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

  const connected = registered && daemonOnline;

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
        Run this in your terminal to link your machine.
      </p>
      {generatingToken ? (
        <div className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground animate-pulse">
          Generating token...
        </div>
      ) : generatedToken ? (
        <div className="space-y-2">
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
        </div>
      ) : null}
    </div>
  );
}
