"use client";


import { useQuery, useMutation, type Query } from "@tanstack/react-query";
import { applicationKey, useApplicationOwner, runApplicationRequest } from "@/lib/application-owner";
import { useApplicationViewSource } from "@/hooks/use-application-view-source";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { getInviteInfo, acceptInvite } from "@/lib/api";
import { trackInviteAccepted } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type State = "loading" | "ready" | "error" | "accepting" | "done";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const owner = useApplicationOwner();
  const source = useApplicationViewSource(`workspace-invite:${token}`);
  const query = useQuery({ queryKey: applicationKey(owner, "workspace-invite", token), enabled: !!token, retry: false,
    queryFn: ({ signal }) => runApplicationRequest(owner, (options) => getInviteInfo(token, options), signal) });
  const command = useMutation({ mutationKey: applicationKey(owner, "workspace-invite", token, "accept"), gcTime: 0,
    mutationFn: async ({ original, resources }: { original: ReturnType<typeof source.capture>; resources: Query[] }) => {
      original.assert();
      const result = await acceptInvite(token, { authenticationAccount: owner.userId, signal: original.signal, assertActive: original.assert, onUnauthorized: async () => { original.assert(); return false; } });
      original.assert();
      await owner.queryClient.invalidateQueries({ queryKey: applicationKey(owner, "workspaces"), predicate: (query) => resources.includes(query) }, { cancelRefetch: false });
      original.assert();
      return result;
    } });
  const info = query.data;
  const error = command.error ?? query.error;
  const errorMsg = error instanceof Error ? error.message : "Invalid or expired invite link";
  const state: State = command.isPending ? "accepting" : command.isSuccess ? "done" : error ? "error" : query.isPending ? "loading" : "ready";

  const handleAccept = async () => {
    if (!token || owner.queryClient.isMutating({ mutationKey: applicationKey(owner, "workspace-invite", token, "accept"), exact: true })) return;
    const original = source.capture();
    try {
      const result = await command.mutateAsync({ original, resources: owner.queryClient.getQueryCache().findAll({ queryKey: applicationKey(owner, "workspaces") }) });
      original.assert();
      trackInviteAccepted({ workspace_id: result.workspace_id ?? "" });
      toast.success(`Joined ${info?.workspace_name ?? "workspace"}`);
      router.replace(`/w/${result.workspace_slug}/home`);
    } catch {
      try { original.assert(); } catch { return; }
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

            <div className="rounded-md border border-border/50 px-4 py-3 text-left space-y-1">
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
