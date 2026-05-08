"use client";

import type { AgentRuntime as Runtime } from "@alook/shared";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { ProviderLogo } from "@/components/provider-logo";
import type { TeamMember } from "./team-preview";

export function AiToolStep({
  members,
  runtimes,
  onAssign,
}: {
  members: TeamMember[];
  runtimes: Runtime[];
  onAssign: (memberIndex: number, runtimeId: string) => void;
}) {
  if (runtimes.length <= 1) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">Assign execution environments</h2>
      <p className="text-xs text-muted-foreground">
        Choose which AI tool each teammate uses.
      </p>
      <div className="space-y-2">
        {members.map((m, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-sm font-medium w-20 truncate">{m.name}</span>
            <div className="flex-1">
              <Select value={m.runtimeId} onValueChange={(val) => { if (val) onAssign(i, val); }}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {runtimes.map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>
                      <div className="flex items-center gap-2">
                        <ProviderLogo provider={rt.provider || ""} className="size-3.5" />
                        <span>{rt.provider || rt.runtime_mode} on {rt.device_info || "machine"}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
