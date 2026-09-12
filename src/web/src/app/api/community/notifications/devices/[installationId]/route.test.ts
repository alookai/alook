import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { kind: "human", userId: "session-user" } as
    | { kind: "human"; userId: string }
    | { kind: "bot"; userId: string },
  db: { primary: true },
  disablePushDevice: vi.fn(),
  params: { installationId: "installation-123" } as Record<string, string>,
  withCommunityActor: vi.fn(
    (handler: (req: NextRequest, ctx: Record<string, unknown>) => Promise<Response>) =>
      async (req: NextRequest) => handler(req, {
        env: { DB: {} },
        actor: mocks.actor,
        params: mocks.params,
      }),
  ),
}));

vi.mock("@/lib/db", () => ({
  getPrimaryDb: vi.fn(() => mocks.db),
}));

vi.mock("@alook/shared", () => ({
  queries: {
    communityPushDevice: {
      disablePushDevice: (...args: unknown[]) =>
        mocks.disablePushDevice(...args),
    },
  },
}));

vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: mocks.withCommunityActor,
}));

import { DELETE } from "./route";

function request(headers: Record<string, string> = {}) {
  return new NextRequest(
    "https://alook.ai/api/community/notifications/devices/installation-123",
    {
      method: "DELETE",
      headers: { Origin: "https://alook.ai", ...headers },
    },
  );
}

describe("DELETE /api/community/notifications/devices/:installationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    mocks.actor = { kind: "human", userId: "session-user" };
    mocks.params = { installationId: "installation-123" };
    mocks.disablePushDevice.mockResolvedValue(true);
  });

  it("scopes a decoded installation id to the current session user", async () => {
    mocks.params = { installationId: "safe%3Ainstallation_123" };

    const response = await DELETE(request());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.disablePushDevice).toHaveBeenCalledWith(mocks.db, {
      userId: "session-user",
      installationId: "safe:installation_123",
      now: "2026-09-12T00:00:00.000Z",
    });
  });

  it.each([
    ["authorization header", { Authorization: "Bearer al_fake" }, "human"],
    ["bot actor", {}, "bot"],
    ["cross origin", { Origin: "https://evil.example" }, "human"],
  ] as const)("rejects %s before persistence", async (_name, headers, actorKind) => {
    mocks.actor = actorKind === "bot"
      ? { kind: "bot", userId: "bot-user" }
      : { kind: "human", userId: "session-user" };

    const response = await DELETE(request(headers));

    expect(response.status).toBe(
      _name === "authorization header" ? 401 : 403,
    );
    expect(mocks.disablePushDevice).not.toHaveBeenCalled();
  });

  it.each([undefined, "bad id", "%E0%A4%A"])(
    "rejects an invalid path id %s",
    async (installationId) => {
      mocks.params = installationId === undefined ? {} : { installationId };

      const response = await DELETE(request());

      expect(response.status).toBe(400);
      expect(mocks.disablePushDevice).not.toHaveBeenCalled();
    },
  );

  it("returns the same empty 204 for disabled, missing, or foreign rows", async () => {
    mocks.disablePushDevice.mockResolvedValue(false);

    const response = await DELETE(request());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
