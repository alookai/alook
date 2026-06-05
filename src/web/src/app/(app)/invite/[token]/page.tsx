"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { getInviteInfo, acceptInvite, type InviteInfo } from "@/lib/api";
import { trackInviteAccepted } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type State = "loading" | "ready" | "error" | "accepting" | "done";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const [state, setState] = useState<State>("loading");
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    getInviteInfo(token)
      .then((data) => {
        setInfo(data);
        setState("ready");
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : "Invalid or expired invite link");
        setState("error");
      });
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setState("accepting");
    try {
      const result = await acceptInvite(token);
      trackInviteAccepted({ workspace_id: result.workspace_id ?? "" });
      setState("done");
      toast.success(`Joined ${info?.workspace_name ?? "workspace"}`);
      router.replace(`/w/${result.workspace_slug}/home`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to join workspace");
      setState("error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        {state === "loading" && (
          <div className="space-y-3">
            <Skeleton className="h-6 w-48 mx-auto" />
            <Skeleton className="h-4 w-64 mx-auto" />
            <Skeleton className="h-9 w-32 mx-auto" />
          </div>
        )}

        {state === "ready" && info && (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">You&apos;ve been invited</h1>
              <p className="text-sm text-muted-foreground">
                {info.invited_by} invited you to join
              </p>
            </div>

            <div className="rounded-md border border-border/50 px-4 py-3 text-left space-y-0.5">
              <p className="text-sm font-medium">{info.workspace_name}</p>
              <p className="text-xs text-muted-foreground">Workspace</p>
            </div>

            <Button className="w-full" onClick={handleAccept}>
              Join Workspace
            </Button>
          </>
        )}

        {state === "accepting" && (
          <div className="space-y-3">
            <Skeleton className="h-6 w-48 mx-auto" />
            <Skeleton className="h-4 w-64 mx-auto" />
            <p className="text-sm text-muted-foreground">Joining workspace…</p>
          </div>
        )}

        {state === "error" && (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Invite unavailable</h1>
              <p className="text-sm text-muted-foreground">{errorMsg}</p>
            </div>
            <Button variant="outline" onClick={() => router.replace("/workspaces")}>
              Go to workspaces
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
