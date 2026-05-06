"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { WorkspaceOverview } from "@/lib/api";
import type { Agent } from "@alook/shared";

interface EmailSummaryProps {
  overview: WorkspaceOverview;
  agents: Agent[];
}

export function EmailSummary({ overview, agents }: EmailSummaryProps) {
  const { inbound, outbound, unread, rejected } = overview.email_stats;

  const agentMap = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xl font-semibold">{inbound}</p>
            <p className="text-xs text-muted-foreground">Received</p>
          </div>
          <div>
            <p className="text-xl font-semibold">{outbound}</p>
            <p className="text-xs text-muted-foreground">Sent</p>
          </div>
          <div>
            <p className={`text-xl font-semibold ${unread > 0 ? "text-primary" : ""}`}>{unread}</p>
            <p className="text-xs text-muted-foreground">Unread</p>
          </div>
          <div>
            <p className={`text-xl font-semibold ${rejected > 0 ? "text-amber-500" : ""}`}>{rejected}</p>
            <p className="text-xs text-muted-foreground">Untrust</p>
          </div>
        </div>

        {overview.email_accounts.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/50">
            <p className="text-xs font-medium text-muted-foreground">Custom Mailboxes</p>
            {overview.email_accounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <Tooltip>
                    <TooltipTrigger render={
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${acc.status === "active" ? "bg-emerald-500" : "bg-destructive"}`}
                      />
                    } />
                    <TooltipContent side="top">
                      {acc.status === "active" ? "Active" : `Error: ${acc.error_message || "inactive"}`}
                    </TooltipContent>
                  </Tooltip>
                  <span className="truncate">{acc.email_address}</span>
                </div>
                <span className="text-muted-foreground shrink-0">
                  {agentMap.get(acc.agent_id) ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
