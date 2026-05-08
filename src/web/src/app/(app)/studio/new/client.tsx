"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, XCircle, LogOut, ArrowLeft, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { signOut } from "@/lib/auth-client";

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
import { listRuntimes, createMachineToken } from "@/lib/api";
import { useUserWs } from "@/lib/use-user-ws";

export function StudioOnboardingClient({
  workspaceId,
  workspaceSlug,
  workspaceName,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}) {
  const router = useRouter();

  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [loadingRuntimes, setLoadingRuntimes] = useState(true);
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(null);
  const [studioName, setStudioName] = useState(workspaceName === "Personal" ? "" : workspaceName);
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);

  // Connect machine state
  const [generatedToken, setGeneratedToken] = useState("");
  const [generatingToken, setGeneratingToken] = useState(false);
  const [machineRegistered, setMachineRegistered] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const hasOnlineRuntime = onlineRuntimes.length > 0;
  const onlineMachineCount = new Set(onlineRuntimes.map((r) => r.daemon_id).filter(Boolean)).size;

  // Fetch runtimes on mount
  useEffect(() => {
    listRuntimes(workspaceId)
      .then(setRuntimes)
      .catch(() => {})
      .finally(() => setLoadingRuntimes(false));
  }, [workspaceId]);

  // WebSocket for runtime registration events
  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (
      msg.type === "runtime.registered" ||
      (msg.type === "runtime.status" && (msg as any).payload?.status === "online")
    ) {
      setMachineRegistered(true);
      listRuntimes(workspaceId).then(setRuntimes).catch(() => {});
    }
  }, [workspaceId]);

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
      const res = await fetch(
        `/api/studios/check-name?name=${encodeURIComponent(studioName.trim())}&workspace_id=${workspaceId}`,
      );
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
      const res = await createMachineToken("cli", workspaceId);
      setGeneratedToken(res.token);
    } catch {
      toast.error("Failed to generate token");
    } finally {
      setGeneratingToken(false);
    }
  }, [workspaceId]);

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
          name: studioName.trim() || undefined,
          scenario: scenarioId,
          members: members.map((m) => ({
            name: m.name,
            role: m.role,
            runtime_id: m.runtimeId,
            description: m.description,
            instructions: m.instructions,
            avatar_url: m.avatarUrl || null,
            email_handle: m.emailHandle || undefined,
          })),
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json()) as { error?: string };
        throw new Error(errBody.error || "Failed to create studio");
      }

      const data = (await res.json()) as { workspace: { slug: string }; leader_agent_id: string };
      toast.success("Studio created!");
      router.push(`/w/${data.workspace.slug}/agents/${data.leader_agent_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create studio");
      setCreating(false);
    }
  };

  const canCreate =
    scenarioId &&
    members.length > 0 &&
    members.every((m) => m.runtimeId) &&
    nameAvailable !== false &&
    (hasOnlineRuntime || machineRegistered);

  // Page 1: Scenario selection
  if (!scenarioId) {
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center p-6">
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-4 left-4 text-xs text-muted-foreground"
          onClick={() => router.push("/workspaces")}
        >
          <LayoutGrid className="size-3 mr-1.5" />
          Workspaces
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-4 right-4 text-xs text-muted-foreground"
          onClick={() => signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })}
        >
          <LogOut className="size-3 mr-1.5" />
          Sign out
        </Button>

        <div className="w-full max-w-3xl space-y-8">
          <div className="text-center space-y-1">
            <h1 className="text-lg font-semibold">What will your studio focus on?</h1>
            <p className="text-xs text-muted-foreground">
              Pick a scenario to assemble the right team.
            </p>
          </div>

          <ScenarioPicker selected={scenarioId} onSelect={handleScenarioSelect} />
        </div>
      </div>
    );
  }

  // Page 2: Build your AI studio
  return (
    <div className="relative flex min-h-dvh flex-col items-center p-6">
      <div className="absolute top-4 left-4 flex items-center gap-1">
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
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-4 text-xs text-muted-foreground"
        onClick={() => signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })}
      >
        <LogOut className="size-3 mr-1.5" />
        Sign out
      </Button>

      <div className="w-full max-w-3xl space-y-8 py-12">
        {/* Header */}
        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold">Build your AI studio</h1>
          <p className="text-xs text-muted-foreground">
            Name your team, connect a machine, and start working.
          </p>
        </div>

        {/* Loading */}
        {loadingRuntimes ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Studio Name */}
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Studio name</h2>
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
              {nameAvailable === false && (
                <p className="text-xs text-red-500 flex items-center gap-1">
                  <XCircle className="size-3" /> Name is taken, try another
                </p>
              )}
              <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                {nameAvailable === true && (
                  <span className="text-emerald-600 flex items-center gap-0.5">
                    <CheckCircle2 className="size-3" /> Available
                  </span>
                )}
                {nameAvailable === true && <span>·</span>}
                <span>Optional — you can always rename later.</span>
              </p>
            </div>

            {/* Team Preview (with runtime picker in each card if multiple) */}
            <TeamPreview
              members={members}
              runtimes={onlineRuntimes as Runtime[]}
              onShuffle={handleShuffle}
              onAssignRuntime={handleAssignRuntime}
            />

            {/* Connect Machine */}
            <div className="space-y-3">
              <h2 className="text-sm font-medium">Connect a computer</h2>
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
                      Register another computer
                    </button>
                  </div>
                  {showRegister && (
                    <ConnectMachineSteps
                      generatedToken={generatedToken}
                      generatingToken={generatingToken}
                      onGenerateToken={handleGenerateToken}
                      registered={machineRegistered}
                    />
                  )}
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Your studio needs a connected computer to run tasks.
                  </p>
                  <ConnectMachineSteps
                    generatedToken={generatedToken}
                    generatingToken={generatingToken}
                    onGenerateToken={handleGenerateToken}
                    registered={machineRegistered}
                  />
                </>
              )}
            </div>

            {/* Create */}
            <Button
              onClick={handleCreate}
              disabled={!canCreate || creating}
              className="w-full"
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  Creating studio...
                </>
              ) : (
                "Create studio"
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
