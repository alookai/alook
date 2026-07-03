"use client";

import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/contexts/workspace-context";
import { ArrowUpRight } from "lucide-react";
import type { WorkspaceOverview } from "@/lib/api";

interface TeamAccessProps {
  overview: WorkspaceOverview;
}

export function TeamAccess({ overview }: TeamAccessProps) {
  const router = useRouter();
  const { slug } = useWorkspace();
  const { members, pending_invites } = overview;

  return (
    <Card>
      <CardHeader>
        <CardAction>
          <button
            type="button"
            onClick={() => router.push(`/w/${slug}/settings`)}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <ArrowUpRight className="size-4" />
          </button>
        </CardAction>
        <CardTitle>
          Team
          {pending_invites > 0 && (
            <span className="ml-2 text-xs text-muted-foreground font-normal">
              ({pending_invites} pending invite{pending_invites > 1 ? "s" : ""})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/50">
          {[...members].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0)).map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2">
              {m.image ? (
                <img
                  src={m.image}
                  alt={m.name}
                  className="size-7 rounded-full shrink-0"
                />
              ) : (
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                  {(m.name || m.email).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">
                  {m.name || m.email}
                </span>
                {m.name && (
                  <span className="text-xs text-muted-foreground truncate block">
                    {m.email}
                  </span>
                )}
              </div>
              <Badge
                variant={m.role === "owner" ? "default" : "secondary"}
                className="text-[10px] px-2 py-0 shrink-0"
              >
                {m.role}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
