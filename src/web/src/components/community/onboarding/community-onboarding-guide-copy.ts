import { isPresenceOnline } from "@alook/shared";
import type { CommunityOnboardingState } from "@/lib/community-onboarding";
import type { GuideContext, GuideCopy, GuideTarget } from "./community-onboarding-guide-types";

const target = (name: GuideTarget["name"], resourceId?: string): GuideTarget => ({
  name,
  ...(resourceId ? { resourceId } : {}),
});

function stableOfflineMachine(machines: GuideContext["machines"]) {
  return machines
    .filter((machine) => !isPresenceOnline(machine.status))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

function recoveryCopy(machine: GuideContext["machines"][number], eyebrow: string): GuideCopy {
  return {
    target: target("reconnect-machine", machine.id),
    eyebrow,
    title: "Bring your machine back online",
    route: "/c/me/machines",
  };
}

export function guideCopy(
  state: CommunityOnboardingState,
  { machines, bots }: GuideContext,
): GuideCopy | null {
  if (state.stage === "machine") {
    if (machines.some((machine) => isPresenceOnline(machine.status))) return null;
    const offlineMachine = stableOfflineMachine(machines);
    if (offlineMachine) return recoveryCopy(offlineMachine, "Step 1 of 4");
    return {
      target: target("connect-machine"),
      eyebrow: "Step 1 of 4",
      title: "Give your bot a place to run",
      route: "/c/me/machines",
    };
  }
  if (state.stage === "bot") {
    const boundMachineId = state.botId
      ? bots.find((bot) => bot.id === state.botId)?.machineId
      : undefined;
    const boundMachine = boundMachineId
      ? machines.find((machine) => machine.id === boundMachineId)
      : undefined;
    if (boundMachine && !isPresenceOnline(boundMachine.status)) {
      return recoveryCopy(boundMachine, "Step 2 of 4");
    }
    if (!machines.some((machine) => isPresenceOnline(machine.status))) {
      const offlineMachine = stableOfflineMachine(machines);
      if (offlineMachine) return recoveryCopy(offlineMachine, "Step 2 of 4");
      return {
        target: target("connect-machine"),
        eyebrow: "Step 2 of 4",
        title: "Give your bot a place to run",
        route: "/c/me/machines",
      };
    }
    if (state.botId) {
      return {
        target: target("create-bot"),
        eyebrow: "Step 2 of 4",
        title: "Meet your bot in chat",
        route: "/c/me/bots",
      };
    }
    return {
      target: target("create-bot"),
      eyebrow: "Step 2 of 4",
      title: "Create a bot with a voice of its own",
      route: "/c/me/bots",
    };
  }
  if (state.stage === "dm") {
    return {
      target: target("dm-composer"),
      eyebrow: "Step 3 of 4",
      title: "Start a conversation with your bot",
      route: state.dmId ? `/c/me/${state.dmId}` : undefined,
    };
  }
  const recovering = Boolean(state.serverId);
  return {
    target: target("add-server"),
    eyebrow: "Step 4 of 4",
    title: recovering
      ? "Bring your bot into the server"
      : "Make a shared home for friends and family",
  };
}
