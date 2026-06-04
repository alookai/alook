"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, XCircle, LogOut, ArrowLeft, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { signOut } from "@/lib/auth-client";
import { clearAllCache } from "@/lib/chat-cache";

import { PublicLayout } from "@/components/public-layout";
import { ConnectMachineSteps } from "@/components/connect-machine-steps";
import { ScenarioPicker } from "@/components/studio-onboarding/scenario-picker";
import { TeamPreview, type TeamMember } from "@/components/studio-onboarding/team-preview";
import {
  SCENARIO_PRESETS,
  shuffleMembers,
  type ScenarioId,
} from "@/components/studio-onboarding/scenario-presets";

import type { AgentRuntime as Runtime } from "@alook/shared";
import type { WsMessage } from "@alook/shared";
import { isTauri, isDesktop } from "@alook/shared";
import { listRuntimes, createMachineToken } from "@/lib/api";
import { useUserWs } from "@/lib/use-user-ws";
import type { TemplatePreset } from "@/lib/templates";

export function StudioOnboardingClient({
  workspaceId: initialWorkspaceId,
  workspaceSlug,
  workspaceName,
  initialTemplate,
}: {
  workspaceId: string | null;
  workspaceSlug: string;
  workspaceName: string;
  initialTemplate?: TemplatePreset;
}) {
  const router = useRouter();
  const isNewWorkspace = !initialWorkspaceId;

  const [workspaceId, setWorkspaceId] = useState<string | null>(initialWorkspaceId);
  const workspaceIdRef = useRef(workspaceId);
  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [loadingRuntimes, setLoadingRuntimes] = useState(!!initialWorkspaceId);
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(
    initialTemplate ? initialTemplate.baseScenario : null,
  );
  const [studioName, setStudioName] = useState(
    isNewWorkspace ? "" : (workspaceName === "Personal" ? "" : workspaceName),
  );
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);

  // Connect machine state
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);
  const [machineRegistered, setMachineRegistered] = useState(false);
  const [daemonOnline, setDaemonOnline] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  const isTauriDesktop = isTauri() && isDesktop();
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const hasOnlineRuntime = onlineRuntimes.length > 0;
  const onlineMachineCount = new Set(onlineRuntimes.map((r) => r.daemon_id).filter(Boolean)).size;

  // Fetch runtimes on mount (only if workspace exists)
  useEffect(() => {
    if (!workspaceId) return;
    listRuntimes(workspaceId)
      .then(setRuntimes)
      .catch(() => {})
      .finally(() => setLoadingRuntimes(false));
  }, [workspaceId]);

  // WebSocket for runtime registration events
  const handleWsMessage = useCallback((msg: WsMessage) => {
    const currentWsId = workspaceIdRef.current;
    if (msg.type === "runtime.registered") {
      setMachineRegistered(true);
      const eventWsId = msg.workspaceId;
      if (eventWsId && !currentWsId) {
        setWorkspaceId(eventWsId);
        listRuntimes(eventWsId).then(setRuntimes).catch(() => {});
      } else if (currentWsId) {
        listRuntimes(currentWsId).then(setRuntimes).catch(() => {});
      }
    } else if (msg.type === "runtime.status" && msg.status === "online") {
      setDaemonOnline(true);
      const wsId = workspaceIdRef.current;
      if (wsId) {
        listRuntimes(wsId).then(setRuntimes).catch(() => {});
      }
    }
  }, []);

  useUserWs(handleWsMessage);

  // Auto-assign first online runtime when runtimes load/change
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

  // Initialize from template when runtimes are loaded
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

  const handleCheckName = async () => {
    if (!studioName.trim()) return;
    setCheckingName(true);
    setNameAvailable(null);
    try {
      const url = workspaceId
        ? `/api/studios/check-name?name=${encodeURIComponent(studioName.trim())}&workspace_id=${workspaceId}`
        : `/api/studios/check-name?name=${encodeURIComponent(studioName.trim())}`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error || "Invalid company name");
        setNameAvailable(false);
        return;
      }
      const data = (await res.json()) as { available: boolean };
      setNameAvailable(data.available);
    } catch {
      setNameAvailable(null);
      toast.error("Failed to check name availability");
    } finally {
      setCheckingName(false);
    }
  };

  const handleGenerateToken = useCallback(async () => {
    setGeneratingToken(true);
    try {
      const res = await createMachineToken("cli", workspaceIdRef.current || undefined);
      setGeneratedToken(res.token);
    } catch {
      toast.error("Failed to generate token");
    } finally {
      setGeneratingToken(false);
    }
  }, []);

  const handleAssignRuntime = (memberIndex: number, runtimeId: string) => {
    setMembers((prev) =>
      prev.map((m, i) => (i === memberIndex ? { ...m, runtimeId } : m)),
    );
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      if (!workspaceId) {
        toast.error("Please connect a computer first");
        setCreating(false);
        return;
      }

      // In Tauri desktop, the app IS the computer — wait for its runtime to
      // come online if members don't have runtimeIds assigned yet.
      let resolvedMembers = members;
      if (isTauriDesktop && members.some((m) => !m.runtimeId)) {
        let attempts = 0;
        let freshRuntimes: Runtime[] = [];
        while (attempts < 10) {
          freshRuntimes = await listRuntimes(workspaceId);
          const firstOnline = freshRuntimes.find((r) => r.status === "online");
          if (firstOnline) {
            resolvedMembers = members.map((m) =>
              m.runtimeId ? m : { ...m, runtimeId: firstOnline.id },
            );
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;
        }
        if (resolvedMembers.some((m) => !m.runtimeId)) {
          toast.error("Waiting for runtime — please ensure the daemon is running");
          setCreating(false);
          return;
        }
      }

      const res = await fetch("/api/studios", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-ID": workspaceId,
        },
        body: JSON.stringify({
          name: studioName.trim() || undefined,
          scenario: scenarioId,
          members: resolvedMembers.map((m) => ({
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
      toast.success("Company created!");
      router.push(`/w/${data.workspace.slug}/agents/${data.leader_agent_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create company");
      setCreating(false);
    }
  };

  const nameValid =
    isNewWorkspace
      ? studioName.trim() && nameAvailable === true
      : nameAvailable !== false;

  const canCreate =
    scenarioId &&
    members.length > 0 &&
    (isTauriDesktop || members.every((m) => m.runtimeId)) &&
    nameValid &&
    (hasOnlineRuntime || machineRegistered || isTauriDesktop);

  // Page 1: Scenario selection
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

          <ScenarioPicker selected={scenarioId} onSelect={handleScenarioSelect} onBrowseTemplates={() => router.push(workspaceId ? `/templates?workspace_id=${workspaceId}` : "/templates")} />

          {workspaceId && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => {
                  document.cookie = `skip_init=${workspaceId};path=/;max-age=86400`;
                  router.push(`/w/${workspaceSlug}/home`);
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip for now
              </button>
            </div>
          )}
        </div>
      </PublicLayout>
    );
  }

  // Page 2: Build your company
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
        {/* Header */}
        <div className="text-center">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-news)" }}
          >
            Build your company
          </h1>
        </div>

        {/* Loading */}
        {loadingRuntimes ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Company Name */}
            <div className="space-y-2">
              <h2 className="text-base font-semibold tracking-tight">Company name</h2>
              <div className="flex gap-2">
                <Input
                  value={studioName}
                  onChange={(e) => {
                    setStudioName(e.target.value);
                    setNameAvailable(null);
                  }}
                  placeholder="e.g. Atlas Lab"
                  className="text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckName}
                  disabled={!studioName.trim() || checkingName}
                  className="shrink-0"
                >
                  {checkingName ? <Loader2 className="size-3 animate-spin" /> : "Check"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {nameAvailable === true && (
                    <>
                      <span className="text-emerald-600 flex items-center gap-0.5">
                        <CheckCircle2 className="size-3" /> Available
                      </span>
                      <span>·</span>
                    </>
                  )}
                  {!isNewWorkspace ? (
                    <span>Optional — you can always rename later.</span>
                  ) : (
                    <span>Required — pick a name for your company.</span>
                  )}
                </span>
                {nameAvailable === false && (
                  <span className="text-red-500 flex items-center gap-1 ml-auto">
                    <XCircle className="size-3" /> Name is taken, try another
                  </span>
                )}
              </div>
            </div>

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
                {hasOnlineRuntime ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-emerald-600 flex items-center gap-1">
                        <CheckCircle2 className="size-3" /> {onlineMachineCount} computer{onlineMachineCount > 1 ? "s" : ""} connected
                      </p>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowRegister((v) => !v)}
                      >
                        Register another
                      </button>
                    </div>
                    {showRegister && (
                      <div className="rounded-xl bg-muted/40 p-5">
                        <ConnectMachineSteps
                          generatedToken={generatedToken}
                          generatingToken={generatingToken}
                          onGenerateToken={handleGenerateToken}
                          registered={machineRegistered}
                          daemonOnline={daemonOnline}
                        />
                      </div>
                    )}
                  </div>
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
              ) : isNewWorkspace && studioName.trim() && nameAvailable !== true ? (
                "Check company name first"
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
