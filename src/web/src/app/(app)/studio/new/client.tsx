"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { WorkspaceProvider, useWorkspaceOwner, captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { apiFetch } from "@/lib/api/client";
import { applicationKey } from "@/lib/application-owner";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, LogOut, ArrowLeft, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/api/client";
import { useApplicationSignOut } from "@/hooks/use-application-sign-out";
import { assertApplicationOwner, captureApplicationOwner } from "@/lib/application-owner";
import { useApplicationOwner } from "@/lib/application-owner";
import { trackWorkspaceCreated, trackOnboardingCompleted, trackAgentCreated } from "@/lib/analytics";

import { PublicLayout } from "@/components/public-layout";
import { ScenarioPicker } from "@/components/studio-onboarding/scenario-picker";
import { TeamPreview, type TeamMember } from "@/components/studio-onboarding/team-preview";
import {
  SCENARIO_PRESETS,
  shuffleMembers,
  type ScenarioId,
} from "@/components/studio-onboarding/scenario-presets";

import type { AgentRuntime as Runtime } from "@alook/shared";
import type { WsMessage } from "@alook/shared";
import { listRuntimes, createMachineToken } from "@/lib/api";
import { useUserWs } from "@/lib/use-user-ws";
import { ConnectMachineSteps } from "@/components/connect-machine-steps";
import type { TemplatePreset } from "@/lib/templates";

export function StudioOnboardingClient(props: { workspaceId: string; workspaceSlug: string; initialTemplate?: TemplatePreset }) {
  return <WorkspaceProvider workspaceId={props.workspaceId} slug={props.workspaceSlug}><StudioOnboardingInner {...props} /></WorkspaceProvider>;
}

function StudioOnboardingInner({
  workspaceId,
  workspaceSlug,
  initialTemplate,
}: {
  workspaceId: string;
  workspaceSlug: string;
  initialTemplate?: TemplatePreset;
}) {
  const applicationOwner = useApplicationOwner();
  const logout = useApplicationSignOut();
  const onLogout = async () => {
    const token = captureApplicationOwner(applicationOwner);
    try { if (await logout.mutateAsync()) router.push("/sign-in"); }
    catch (error) { toastApiError(error, "Failed to log out", () => assertApplicationOwner(token)); }
  };
  const router = useRouter();

  const owner = useWorkspaceOwner();
  const source = useWorkspaceViewSource(owner, "studio-onboarding", true);
  const runtimesKey = owner.key("runtimes");
  const runtimesQuery = useQuery({ queryKey: runtimesKey,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listRuntimes(workspaceId, options), signal),
    refetchInterval: 30_000, refetchIntervalInBackground: false,
  });
  const runtimes = runtimesQuery.data ?? [];
  const loadingRuntimes = runtimesQuery.isPending;
  const [scenarioId, setScenarioId] = useAtom(useCreateAtom<ScenarioId | null>(initialTemplate ? initialTemplate.baseScenario : null));
  const [memberDrafts, setMembers] = useAtom(useCreateAtom<TeamMember[]>([]));
  const [registeredDaemonId, setRegisteredDaemonId] = useAtom(useCreateAtom<string | null>(null));
  const handlesQuery = useQuery({
    queryKey: owner.key("studio-handles", memberDrafts.map(({ uid, name }) => ({ uid, name }))),
    enabled: memberDrafts.length > 0, retry: false, gcTime: 0,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => apiFetch<{ uid: string; handle: string }[]>("/api/studios/check-handles", {
      ...options, method: "POST", body: JSON.stringify({ members: memberDrafts.map(({ uid, name }) => ({ uid, name })) }),
    }), signal),
  });
  const members = useMemo(() => memberDrafts.map((member) => ({
    ...member, emailHandle: handlesQuery.data?.find((row) => row.uid === member.uid)?.handle,
  })), [memberDrafts, handlesQuery.data]);
  const tokenQuery = useQuery({ queryKey: owner.key("studio-pairing"), enabled: false, gcTime: 0, retry: false,
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => createMachineToken("cli", workspaceId, options), signal),
  });
  const generatedToken = tokenQuery.data?.token ?? "";
  const generatingToken = tokenQuery.isFetching;
  const onlineRuntimes = useMemo(() => (runtimesQuery.data ?? []).filter((runtime) => runtime.status === "online"), [runtimesQuery.data]);
  const hasOnlineRuntime = onlineRuntimes.length > 0;
  const daemonOnline = registeredDaemonId ? runtimes.some((runtime) => runtime.daemon_id === registeredDaemonId && runtime.status === "online") : hasOnlineRuntime;
  const machineRegistered = !!registeredDaemonId || hasOnlineRuntime;
  const computerConnected = hasOnlineRuntime;

  const handleWsMessage = useCallback((message: WsMessage) => {
    try { source.assertActive(); } catch { return; }
    if (message.type === "runtime.registered" && message.workspaceId === workspaceId) {
      setRegisteredDaemonId(message.daemonId);
      void owner.queryClient.invalidateQueries({ queryKey: runtimesKey, exact: true });
    } else if (message.type === "runtime.status" && (!message.workspaceId || message.workspaceId === workspaceId)) {
      setRegisteredDaemonId(message.daemonId);
      void owner.queryClient.invalidateQueries({ queryKey: runtimesKey, exact: true });
    }
  }, [workspaceId, source, setRegisteredDaemonId, owner.queryClient, runtimesKey]);

  useUserWs(handleWsMessage, { onReconnect: () => { try { source.assertActive(); } catch { return; } return owner.queryClient.invalidateQueries({ queryKey: runtimesKey, exact: true }); } });

  const handleGenerateToken = async () => {
    const assert = source.assertActive;
    assert();
    try {
      const result = await tokenQuery.refetch({ cancelRefetch: false, throwOnError: true });
      assert();
      return result.data;
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Failed to generate token");
    }
  };

  useEffect(() => {
    const firstOnline = onlineRuntimes[0]?.id;
    if (!firstOnline) return;
    setMembers((previous) => previous.some((member) => !member.runtimeId) ? previous.map((member) => member.runtimeId ? member : { ...member, runtimeId: firstOnline }) : previous);
  }, [onlineRuntimes, setMembers]);

  useEffect(() => {
    if (!initialTemplate || loadingRuntimes || memberDrafts.length > 0) return;
    const generated = shuffleMembers(initialTemplate.members.length);
    const defaultRuntimeId = onlineRuntimes[0]?.id || "";
    setMembers(initialTemplate.members.map((member, index) => ({
      uid: generated[index].uid, name: generated[index].name, role: member.role,
      description: member.description, instructions: member.instructions, avatarUrl: generated[index].avatarUrl,
      runtimeId: defaultRuntimeId, relationship: member.relationship,
    })));
  }, [initialTemplate, loadingRuntimes, memberDrafts.length, onlineRuntimes, setMembers]);

  const handleScenarioSelect = (id: ScenarioId) => {
    setScenarioId(id);
    const preset = SCENARIO_PRESETS.find((scenario) => scenario.id === id)!;
    const generated = shuffleMembers(preset.members.length);
    const defaultRuntimeId = onlineRuntimes[0]?.id || "";
    setMembers(preset.members.map((member, index) => ({
      uid: generated[index].uid, name: generated[index].name, role: member.role,
      description: member.description, instructions: member.instructions, avatarUrl: generated[index].avatarUrl,
      runtimeId: defaultRuntimeId, relationship: member.relationship,
    })));
  };

  const handleShuffle = () => {
    const generated = shuffleMembers(memberDrafts.length);
    setMembers((previous) => previous.map((member, index) => ({ ...member, uid: generated[index].uid, name: generated[index].name, avatarUrl: generated[index].avatarUrl })));
  };

  const handleAssignRuntime = (memberIndex: number, runtimeId: string) => {
    setMembers((previous) => previous.map((member, index) => index === memberIndex ? { ...member, runtimeId } : member));
  };

  const createCommand = useMutation({ gcTime: 0, mutationKey: owner.key("studio-create"), scope: { id: JSON.stringify(owner.key("studio-create")) },
    mutationFn: async ({ scenario, members, token }: { scenario: ScenarioId; members: TeamMember[]; token: ReturnType<typeof captureWorkspaceOwner> }) => {
      const assert = () => assertWorkspaceOwner(token);
      assert();
      let readyMembers = members;
      if (members.some((member) => !member.runtimeId)) {
        const fresh = await owner.queryClient.fetchQuery({ queryKey: runtimesKey,
          queryFn: ({ signal }) => listRuntimes(workspaceId, workspaceRequestOptions(token, signal)), staleTime: 0,
        });
        assert();
        const firstOnline = fresh.find((runtime) => runtime.status === "online")?.id;
        if (!firstOnline) throw new Error("No online runtime to assign — connect a computer and try again");
        readyMembers = members.map((member) => member.runtimeId ? member : { ...member, runtimeId: firstOnline });
      }
      const options = workspaceRequestOptions(token);
      try {
        const data = await apiFetch<{ workspace: { slug: string }; leader_agent_id: string }>("/api/studios", {
          ...options, method: "POST", headers: { "X-Workspace-ID": workspaceId },
          body: JSON.stringify({ scenario, members: readyMembers.map((member) => ({
            name: member.name, role: member.role, runtime_id: member.runtimeId, description: member.description,
            instructions: member.instructions, avatar_url: member.avatarUrl || null, email_handle: member.emailHandle || undefined,
            relationship: member.relationship || undefined,
          })) }),
        });
        assert();
        await apiFetch(`/api/workspaces/${workspaceId}/onboarded`, { ...options, method: "POST" }).catch((error) => { assert(); if (error instanceof DOMException && error.name === "AbortError") throw error; });
        assert();
        await owner.queryClient.invalidateQueries({ queryKey: applicationKey(applicationOwner, "workspaces") });
        assert();
        return data;
      } catch (error) { assert(); throw error; }
    },
  });
  const creating = createCommand.isPending;
  const handleCreate = async () => {
    if (!scenarioId) { toast.error("Pick a focus area first"); return; }
    if (!members.length) { toast.error("Add at least one team member"); return; }
    if (!computerConnected) { toast.error("Connect a computer first — no runtime is online yet"); return; }
    const assert = source.assertActive;
    const token = captureWorkspaceOwner(owner);
    const scenario = scenarioId;
    const team = members;
    assert();
    try {
      const data = await createCommand.mutateAsync({ scenario, members: team, token });
      assert();
      trackWorkspaceCreated("onboarding");
      trackOnboardingCompleted({ template_used: scenario, agent_count: team.length });
      team.forEach((member, index) => trackAgentCreated({ is_first_agent: index === 0, has_email: !!member.emailHandle }));
      toast.success("Company created!");
      router.push(`/w/${data.workspace.slug}/agents/${data.leader_agent_id}`);
    } catch (error) {
      try { assert(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "Failed to create company");
    }
  };


  const finishCommand = useMutation({ mutationKey: owner.key("studio-finish"), gcTime: 0,
    mutationFn: async (intent: ReturnType<typeof source.capture> & { resources: import("@tanstack/react-query").Query[] }) => {
      intent.assert();
      await apiFetch(`/api/workspaces/${workspaceId}/onboarded`, { ...workspaceRequestOptions(intent.token, intent.signal, intent.assert), method: "POST" });
      intent.assert();
      await owner.queryClient.invalidateQueries({ predicate: (query) => intent.resources.includes(query) });
      intent.assert();
      router.push(`/w/${workspaceSlug}/home`);
    },
    onError: (error, intent) => { try { intent.assert(); } catch { return; } toastApiError(error, "Failed to finish onboarding", intent.assert); },
  });
  const finishOnboarding = () => {
    if (owner.queryClient.isMutating({ mutationKey: owner.key("studio-finish"), exact: true })) return;
    const intent = source.capture(); intent.assert();
    finishCommand.mutate({ ...intent, resources: owner.queryClient.getQueryCache().findAll({ queryKey: applicationKey(applicationOwner, "workspaces") }) });
  };

  if (!scenarioId) {
    return (
      <PublicLayout
        leftSlot={
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => router.push("/workspaces")}
          >
            <LayoutGrid className="size-3 mr-2" />
            Workspaces
          </Button>
        }
        rightSlot={
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={onLogout}
          >
            <LogOut className="size-3 mr-2" />
            Sign out
          </Button>
        }
        mainClassName="flex items-center justify-center"
      >
        <div className="w-full max-w-3xl space-y-8 px-6 py-6">
          <div className="text-center space-y-2">
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-news)" }}
            >
              What will your company do?
            </h1>
            <p className="text-sm text-muted-foreground">
              Pick a focus area. You can always add more agents later.
            </p>
          </div>

          <ScenarioPicker selected={scenarioId} onSelect={handleScenarioSelect} onBrowseTemplates={() => router.push(`/templates?workspace_id=${workspaceId}`)} />

          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={finishOnboarding}
              disabled={finishCommand.isPending}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip for now
            </button>
          </div>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout
      leftSlot={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => router.push("/workspaces")}
          >
            <LayoutGrid className="size-3 mr-2" />
            Workspaces
          </Button>
          <span className="text-muted-foreground/40">/</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setScenarioId(null)}
          >
            <ArrowLeft className="size-3 mr-2" />
            Back
          </Button>
        </>
      }
      rightSlot={
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={onLogout}
        >
          <LogOut className="size-3 mr-2" />
          Sign out
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-3xl space-y-10 px-6 py-14">
        <div className="text-center">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-news)" }}
          >
            Build your company
          </h1>
        </div>

        {loadingRuntimes ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Team Preview */}
            <TeamPreview
              members={members}
              runtimes={onlineRuntimes as Runtime[]}
              onShuffle={handleShuffle}
              onAssignRuntime={handleAssignRuntime}
            />

            <div className="space-y-3">
              {computerConnected ? (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="size-3" /> Computer connected
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Your company needs a connected computer to run tasks.
                  </p>
                  <div className="rounded-xl bg-muted/40 p-4">
                    <ConnectMachineSteps
                      generatedToken={generatedToken}
                      generatingToken={generatingToken}
                      onGenerateToken={handleGenerateToken}
                      registered={machineRegistered}
                      daemonOnline={daemonOnline}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Create */}
            <Button
              onClick={handleCreate}
              disabled={creating || !computerConnected}
              className="w-full"
              size="lg"
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  Launching...
                </>
              ) : (
                "Launch company"
              )}
            </Button>
          </>
        )}
      </div>
    </PublicLayout>
  );
}
