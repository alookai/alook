import { describe, expect, it } from "vitest";
import type { CommunityOnboardingState } from "@/lib/community-onboarding";
import { guideCopy } from "./community-onboarding-guide-copy";

const state = (stage: CommunityOnboardingState["stage"], extra = {}) => ({
  status: "active" as const,
  stage,
  ...extra,
});
const machine = (id: string, status: "online" | "offline") => ({ id, status });

describe("guideCopy", () => {
  it("keeps every machine-stage branch and stable offline selection", () => {
    expect(guideCopy(state("machine"), {
      machines: [machine("online", "online")],
      bots: [],
    })).toBeNull();
    expect(guideCopy(state("machine"), { machines: [], bots: [] })).toEqual({
      target: { name: "connect-machine" },
      eyebrow: "Step 1 of 4",
      title: "Give your bot a place to run",
      route: "/c/me/machines",
    });
    expect(guideCopy(state("machine"), {
      machines: [machine("z", "offline"), machine("a", "offline")],
      bots: [],
    })).toEqual({
      target: { name: "reconnect-machine", resourceId: "a" },
      eyebrow: "Step 1 of 4",
      title: "Bring your machine back online",
      route: "/c/me/machines",
    });
  });

  it("prioritizes a pending bot's bound offline machine", () => {
    expect(guideCopy(state("bot", { botId: "bot-1" }), {
      machines: [machine("online", "online"), machine("bound", "offline")],
      bots: [{ id: "bot-1", machineId: "bound" }],
    })).toEqual({
      target: { name: "reconnect-machine", resourceId: "bound" },
      eyebrow: "Step 2 of 4",
      title: "Bring your machine back online",
      route: "/c/me/machines",
    });
  });

  it("keeps bot recovery, creation, and pending-chat copy exact", () => {
    expect(guideCopy(state("bot"), {
      machines: [machine("z", "offline"), machine("a", "offline")],
      bots: [],
    })).toEqual({
      target: { name: "reconnect-machine", resourceId: "a" },
      eyebrow: "Step 2 of 4",
      title: "Bring your machine back online",
      route: "/c/me/machines",
    });
    expect(guideCopy(state("bot"), { machines: [], bots: [] })).toEqual({
      target: { name: "connect-machine" },
      eyebrow: "Step 2 of 4",
      title: "Give your bot a place to run",
      route: "/c/me/machines",
    });
    expect(guideCopy(state("bot"), {
      machines: [machine("online", "online")],
      bots: [],
    })).toEqual({
      target: { name: "create-bot" },
      eyebrow: "Step 2 of 4",
      title: "Create a bot with a voice of its own",
      route: "/c/me/bots",
    });
    expect(guideCopy(state("bot", { botId: "bot-1" }), {
      machines: [machine("online", "online")],
      bots: [{ id: "bot-1", machineId: "online" }],
    })).toEqual({
      target: { name: "create-bot" },
      eyebrow: "Step 2 of 4",
      title: "Meet your bot in chat",
      route: "/c/me/bots",
    });
  });

  it("keeps DM routing optional and exact", () => {
    expect(guideCopy(state("dm"), { machines: [], bots: [] })).toEqual({
      target: { name: "dm-composer" },
      eyebrow: "Step 3 of 4",
      title: "Start a conversation with your bot",
      route: undefined,
    });
    expect(guideCopy(state("dm", { dmId: "dm-7" }), { machines: [], bots: [] }))
      .toEqual({
        target: { name: "dm-composer" },
        eyebrow: "Step 3 of 4",
        title: "Start a conversation with your bot",
        route: "/c/me/dm-7",
      });
  });

  it("keeps both server-stage titles and no route", () => {
    expect(guideCopy(state("server"), { machines: [], bots: [] })).toEqual({
      target: { name: "add-server" },
      eyebrow: "Step 4 of 4",
      title: "Make a shared home for friends and family",
    });
    expect(guideCopy(state("server", { serverId: "server-1" }), {
      machines: [],
      bots: [],
    })).toEqual({
      target: { name: "add-server" },
      eyebrow: "Step 4 of 4",
      title: "Bring your bot into the server",
    });
  });
});
