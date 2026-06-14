import { NextRequest } from "next/server";

const mockEnv: Record<string, unknown> = { DB: {} };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: mockEnv })),
}));

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: mockEnv, userId: "u1", email: "u@t.com", params });
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  delete mockEnv.RUNTIME_MODEL_OPTIONS;
});

describe("GET /api/config/model-options", () => {
  it("returns parsed config when valid JSON", async () => {
    mockEnv.RUNTIME_MODEL_OPTIONS = '{"claude":["claude-opus-4-6","claude-sonnet-4-6"],"opencode":["gpt-4.1"]}';

    const req = new NextRequest("http://localhost/api/config/model-options");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      claude: ["claude-opus-4-6", "claude-sonnet-4-6"],
      opencode: ["gpt-4.1"],
    });
  });

  it("returns {} when env var is unset", async () => {
    const req = new NextRequest("http://localhost/api/config/model-options");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({});
  });

  it("returns {} for invalid JSON string", async () => {
    mockEnv.RUNTIME_MODEL_OPTIONS = "not json{";

    const req = new NextRequest("http://localhost/api/config/model-options");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({});
  });

  it("drops keys with invalid values (non-array)", async () => {
    mockEnv.RUNTIME_MODEL_OPTIONS = '{"claude":"not-array","opencode":["gpt-4.1"]}';

    const req = new NextRequest("http://localhost/api/config/model-options");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ opencode: ["gpt-4.1"] });
  });

  it("returns {} for non-object JSON (array)", async () => {
    mockEnv.RUNTIME_MODEL_OPTIONS = '["a","b"]';

    const req = new NextRequest("http://localhost/api/config/model-options");
    const res = await GET(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({});
  });
});

