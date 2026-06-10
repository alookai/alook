"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, LogOut, ArrowLeft, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { signOut } from "@/lib/auth-client";
import { clearAllCache } from "@/lib/chat-cache";
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
import { isTauri, isDesktop, tauriInvoke } from "@alook/shared";
import { listRuntimes, createMachineToken } from "@/lib/api";
import { useUserWs } from "@/lib/use-user-ws";
import { ConnectMachineSteps } from "@/components/connect-machine-steps";
import type { TemplatePreset } from "@/lib/templates";

export function StudioOnboardingClient({
  workspaceId,
  workspaceSlug,
  workspaceName,
  initialTemplate,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  initialTemplate?: TemplatePreset;
}) {
  const router = useRouter();

  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [loadingRuntimes, setLoadingRuntimes] = useState(true);
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(
    initialTemplate ? initialTemplate.baseScenario : null,
  );
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);

  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);
  const [machineRegistered, setMachineRegistered] = useState(false);
  const [daemonOnline, setDaemonOnline] = useState(false);

  const isTauriDesktop = isTauri() && isDesktop();
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const hasOnlineRuntime = onlineRuntimes.length > 0;

  useEffect(() => {
    listRuntimes(workspaceId)
      .then((rts) => {
        setRuntimes(rts);
        if (rts.some((r) => r.status === "online")) {
          setMachineRegistered(true);
          setDaemonOnline(true);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingRuntimes(false));
  }, [workspaceId]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === "runtime.registered" && msg.workspaceId === workspaceId) {
      setMachineRegistered(true);
      setDaemonOnline(true);
      listRuntimes(workspaceId).then(setRuntimes).catch(() => {});
    } else if (msg.type === "runtime.status" && msg.workspaceId === workspaceId) {
      setMachineRegistered(true);
      if (msg.status === "online") setDaemonOnline(true);
      else setDaemonOnline(false);
    }
  }, [workspaceId]);

  useUserWs(handleWsMessage);

  const handleGenerateToken = useCallback(async () => {
    setGeneratingToken(true);
    try {
      const res = await createMachineToken("cli", workspaceId);
      setGeneratedToken(res.token);
      if (isTauriDesktop) {
        const result = await tauriInvoke<{ success: boolean; message: string }>("register_cli", { token: res.token });
        if (result.success) {
          setMachineRegistered(true);
          setDaemonOnline(true);
          listRuntimes(workspaceId).then(setRuntimes).catch(() => {});
        } else {
          toast.error(result.message || "Auto-registration failed");
        }
      }
    } catch {
      toast.error("Failed to generate token");
    } finally {
      setGeneratingToken(false);
    }
  }, [workspaceId, isTauriDesktop]);

  useEffect(() => {
    const firstOnline = onlineRuntimes[0]?.id;
    if (!firstOnline) return;
    setMembers((prev) => {
      if (prev.length === 0) return prev;
      const needsUpdate = prev.some((m) => !m.runtimeId);
      if (!needsUpdate) return prev;
      return prev.map((m) => m.runtimeId ? m : { ...m, runtimeId: firstOnline });
    });
  }, [onlineRuntimes]);

  const resolveHandles = useCallback(async (memberNames: string[]) => {
    try {
      const res = await fetch("/api/studios/check-handles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: memberNames }),
      });
      if (!res.ok) return null;
      return (await res.json()) as { name: string; handle: string }[];
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!initialTemplate || loadingRuntimes) return;
    if (members.length > 0) return;
    const generated = shuffleMembers(initialTemplate.members.length);
    const defaultRuntimeId = onlineRuntimes[0]?.id || "";
    const newMembers = initialTemplate.members.map((m, i) => ({
      name: generated[i].name,
      role: m.role,
      description: m.description,
      instructions: m.instructions,
      avatarUrl: generated[i].avatarUrl,
      runtimeId: defaultRuntimeId,
      relationship: m.relationship,
    }));
    setMembers(newMembers);
    resolveHandles(newMembers.map((m) => m.name)).then((handles) => {
      if (handles) {
        setMembers((prev) =>
          prev.map((m) => {
            const h = handles.find((r) => r.name === m.name);
            return h ? { ...m, emailHandle: h.handle } : m;
          }),
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplate, loadingRuntimes]);

  const handleScenarioSelect = async (id: ScenarioId) => {
    setScenarioId(id);
    const preset = SCENARIO_PRESETS.find((s) => s.id === id)!;
    const generated = shuffleMembers(preset.members.length);
    const defaultRuntimeId = onlineRuntimes[0]?.id || "";
    const newMembers = preset.members.map((m, i) => ({
      name: generated[i].name,
      role: m.role,
      description: m.description,
      instructions: m.instructions,
      avatarUrl: generated[i].avatarUrl,
      runtimeId: defaultRuntimeId,
      relationship: m.relationship,
    }));
    setMembers(newMembers);
    const handles = await resolveHandles(newMembers.map((m) => m.name));
    if (handles) {
      setMembers((prev) => prev.map((m) => {
        const h = handles.find((r) => r.name === m.name);
        return h ? { ...m, emailHandle: h.handle } : m;
      }));
    }
  };

  const handleShuffle = async () => {
    const generated = shuffleMembers(members.length);
    const newMembers = members.map((m, i) => ({ ...m, name: generated[i].name, avatarUrl: generated[i].avatarUrl, emailHandle: undefined }));
    setMembers(newMembers);
    const handles = await resolveHandles(newMembers.map((m) => m.name));
    if (handles) {
      setMembers((prev) => prev.map((m) => {
        const h = handles.find((r) => r.name === m.name);
        return h ? { ...m, emailHandle: h.handle } : m;
      }));
    }
  };

  const handleAssignRuntime = (memberIndex: number, runtimeId: string) => {
    setMembers((prev) =>
      prev.map((m, i) => (i === memberIndex ? { ...m, runtimeId } : m)),
    );
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/studios", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-ID": workspaceId,
        },
        body: JSON.stringify({
          name: undefined,
          scenario: scenarioId,
          members: members.map((m) => ({
            name: m.name,
            role: m.role,
            runtime_id: m.runtimeId,
            description: m.description,
            instructions: m.instructions,
            avatar_url: m.avatarUrl || null,
            email_handle: m.emailHandle || undefined,
            relationship: m.relationship || undefined,
          })),
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error || "Failed to create company");
      }

      const data = (await res.json()) as { workspace: { slug: string }; leader_agent_id: string };
      await fetch(`/api/workspaces/${workspaceId}/onboarded`, { method: "POST" }).catch(() => {});
      trackWorkspaceCreated("onboarding");
      trackOnboardingCompleted({
        template_used: scenarioId ?? undefined,
        agent_count: members.length,
      });
      for (let i = 0; i < members.length; i++) {
        trackAgentCreated({
          is_first_agent: i === 0,
          has_email: !!members[i].emailHandle,
        });
      }
      toast.success("Company created!");
      router.push(`/w/${data.workspace.slug}/agents/${data.leader_agent_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create company");
      setCreating(false);
    }
  };

  const canCreate =
    scenarioId &&
    members.length > 0 &&
    members.every((m) => m.runtimeId) &&
    (hasOnlineRuntime || (machineRegistered && daemonOnline) || isTauriDesktop);

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
            <LayoutGrid className="size-3 mr-1.5" />
            Workspaces
          </Button>
        }
        rightSlot={
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={async () => { await clearAllCache(); signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } }); }}
          >
            <LogOut className="size-3 mr-1.5" />
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
              onClick={async () => {
                await fetch(`/api/workspaces/${workspaceId}/onboarded`, { method: "POST" }).catch(() => {});
                router.push(`/w/${workspaceSlug}/home`);
              }}
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
            <LayoutGrid className="size-3 mr-1.5" />
            Workspaces
          </Button>
          <span className="text-muted-foreground/40">/</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setScenarioId(null)}
          >
            <ArrowLeft className="size-3 mr-1.5" />
            Back
          </Button>
        </>
      }
      rightSlot={
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={async () => { await clearAllCache(); signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } }); }}
        >
          <LogOut className="size-3 mr-1.5" />
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

            {/* Connect Machine — hidden in Tauri desktop (the app IS the computer) */}
            {!isTauriDesktop && (
              <div className="space-y-3">
                <h2 className="text-base font-semibold tracking-tight">Connect a computer</h2>
                {(hasOnlineRuntime || (machineRegistered && daemonOnline)) ? (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="size-3" /> Computer connected
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Your company needs a connected computer to run tasks.
                    </p>
                    <div className="rounded-xl bg-muted/40 p-5">
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
            )}

            {/* Create */}
            <Button
              onClick={handleCreate}
              disabled={!canCreate || creating}
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
