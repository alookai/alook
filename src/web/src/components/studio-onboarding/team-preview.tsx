"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RefreshCw } from "lucide-react";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ProviderLogo } from "@/components/provider-logo";
import { toAlookAddress } from "@alook/shared";
import type { AgentRuntime as Runtime } from "@alook/shared";
import type { MemberRole } from "./scenario-presets";

export interface TeamMember {
  name: string;
  role: MemberRole;
  description: string;
  instructions: string;
  avatarUrl: string;
  runtimeId: string;
  emailHandle?: string;
  relationship?: string;
}

const ROLE_LABELS: Record<MemberRole, string> = {
  leader: "Lead",
  researcher: "Researcher",
  engineer: "Engineer",
  assistant: "Assistant",
};

export function TeamPreview({
  members,
  runtimes,
  onShuffle,
  onAssignRuntime,
}: {
  members: TeamMember[];
  runtimes: Runtime[];
  onShuffle: () => void;
  onAssignRuntime?: (memberIndex: number, runtimeId: string) => void;
}) {
  const showRuntimePicker = runtimes.length > 1 && onAssignRuntime;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">Your company</h2>
        <Button variant="ghost" size="sm" onClick={onShuffle} className="h-7 text-xs gap-2">
          <RefreshCw className="size-3" />
          Shuffle
        </Button>
      </div>
      <div
        className={cn(
          "grid gap-3 grid-cols-1",
          members.length === 2 && "sm:grid-cols-2",
          members.length === 3 && "sm:grid-cols-2 sm:grid-cols-3",
          members.length >= 4 && "sm:grid-cols-2 sm:grid-cols-4",
        )}
      >
        {members.map((m, i) => {
          const avatarConfig = m.avatarUrl ? parseAvatarUrl(m.avatarUrl) : null;
          return (
            <Card key={i} size="sm" className="flex flex-col px-3 py-4 gap-2 h-full">
              {/* Header: avatar + name/badge */}
              <div className="flex items-center gap-2">
                {avatarConfig ? (
                  <AvatarRenderer config={avatarConfig} size={36} className="rounded-xl shrink-0" />
                ) : (
                  <div className="size-9 rounded-xl bg-muted flex items-center justify-center text-sm font-semibold shrink-0">
                    {m.name.charAt(0)}
                  </div>
                )}
                <div className="flex flex-col items-start gap-1">
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted/60 px-2 py-1 rounded">
                    {ROLE_LABELS[m.role]}
                  </span>
                </div>
              </div>
              {/* Email */}
              <p className="text-[10px] text-muted-foreground/70 font-mono truncate">
                {toAlookAddress(m.emailHandle || m.name.toLowerCase())}
              </p>
              {/* Description — flex-1 to push runtime picker to bottom */}
              <p className="text-[11px] text-muted-foreground leading-snug flex-1">
                {m.description}
              </p>
              {/* Row 4: runtime picker (if multiple) */}
              {showRuntimePicker && (() => {
                const selectedRt = runtimes.find((r) => r.id === m.runtimeId);
                return (
                  <div className="mt-1">
                    <Select value={m.runtimeId} onValueChange={(val) => { if (val) onAssignRuntime(i, val); }}>
                      <SelectTrigger className="h-7 text-[11px]">
                        <div className="flex items-center gap-2 truncate">
                          {selectedRt && <ProviderLogo provider={selectedRt.provider || ""} className="size-3 shrink-0" />}
                          <span className="truncate">{selectedRt?.provider || selectedRt?.runtime_mode || "Select"}</span>
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        {runtimes.map((rt) => (
                          <SelectItem key={rt.id} value={rt.id}>
                            {rt.provider || rt.runtime_mode}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
