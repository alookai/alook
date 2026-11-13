import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ actor: { kind: "bot", userId: "bot", ownerUserId: "owner", machineId: "machine", isActive: true } as Record<string, unknown>, submit: vi.fn(), rate: vi.fn(), unauthenticated: false }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...args: unknown[]) => mocks.rate(...args) }));
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }));
vi.mock("@/lib/middleware/community-actor", async () => ({
  ...await vi.importActual<typeof import("@/lib/middleware/community-actor")>("@/lib/middleware/community-actor"),
  communityActorPolicy: () => ({ resolve: async () => mocks.unauthenticated ? NextResponse.json({ error: "unauthorized" }, { status: 401 }) : { context: { env: { DB: {} }, actor: mocks.actor } } }),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return { ...actual, queries: { ...actual.queries, communityFeedback: { submitFeedback: (...args: unknown[]) => mocks.submit(...args) } } };
});
import { POST } from "./route";
const request = (body: unknown) => new NextRequest("http://local/api/community/platform/feedback", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor = { kind: "bot", userId: "bot", ownerUserId: "owner", machineId: "machine", isActive: true };
  mocks.unauthenticated = false;
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.submit.mockResolvedValue({ id: "feedback", createdAt: "now" });
});
describe("bot feedback API", () => {
  it.each(["😀".repeat(2560), "a" + "\u0000".repeat(10239)])("accepts exact 10 KiB text including JSON escapes", async (text) => {
    const response = await POST(request({ text }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ kind: "bot_feedback", createdAt: "now" });
    expect(mocks.submit).toHaveBeenCalledWith({}, "owner", "bot", { text });
  });
  it.each([{ text: " \n\t" }, { text: "hello", ownerId: "stranger" }, { text: "hello", botId: "stranger" }, {}])("rejects empty or injected fields", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects malformed and oversized raw JSON and decoded UTF-8 bodies", async () => {
    expect((await POST(new NextRequest("http://local", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(request({ text: "😀".repeat(2560) + "a" }))).status).toBe(413);
    expect((await POST(request({ text: "a".repeat(70000) }))).status).toBe(413);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects humans and unauthenticated requests without writing", async () => {
    mocks.actor = { kind: "human", userId: "human" };
    expect((await POST(request({ text: "feedback" }))).status).toBe(403);
    mocks.unauthenticated = true;
    expect((await POST(request({ text: "feedback" }))).status).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
  });
  it("does not acknowledge a failed write", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(POST(request({ text: "feedback" }))).rejects.toThrow("storage unavailable");
  });
});


it("shares quota by authenticated owner across bots and keeps other owners separate", async () => {
  await POST(request({ text: "first" }));
  mocks.actor = { ...mocks.actor, userId: "second-bot" };
  await POST(request({ text: "second" }));
  mocks.actor = { ...mocks.actor, userId: "foreign-bot", ownerUserId: "other-owner" };
  await POST(request({ text: "third" }));
  expect(mocks.rate.mock.calls.map((call) => call.slice(1))).toEqual([
    ["community:feedback", "owner"], ["community:feedback", "owner"], ["community:feedback", "other-owner"],
  ]);
});

it("denies rate-limited requests before consuming the body or writing", async () => {
  mocks.rate.mockResolvedValue({ allowed: false, retryAfterSec: 37 });
  const req = request({ text: "feedback" });
  const response = await POST(req);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("37");
  expect(await response.json()).toEqual({
    error: "Feedback limit reached (10 submissions per owner per hour)",
    code: "RATE_LIMIT_EXCEEDED", hint: "Try again in 37 seconds.",
  });
  expect(req.bodyUsed).toBe(false);
  expect(mocks.submit).not.toHaveBeenCalled();
});
