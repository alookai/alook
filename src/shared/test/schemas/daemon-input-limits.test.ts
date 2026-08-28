import { describe, expect, it } from "vitest";
import {
  ActivateTokenRequestSchema,
  COMMUNITY_RUNTIME_LIST_MAX,
  MAX_POLL_TASKS,
  PollRequestSchema,
  RegisterDaemonRequestSchema,
} from "../../src/schemas";

describe("daemon input limits", () => {
  it("keeps zero invalid and positive legacy poll counts compatible", () => {
    expect(PollRequestSchema.safeParse({ daemon_id: "d1", max_tasks: 0 }).success).toBe(false);
    expect(PollRequestSchema.parse({ daemon_id: "d1", max_tasks: 125 }).max_tasks).toBe(125);
    expect(MAX_POLL_TASKS).toBe(50);
  });

  it.each([
    ["register", RegisterDaemonRequestSchema, { daemon_id: "d1" }, { type: "codex" }],
    ["activate", ActivateTokenRequestSchema, { token: "t1", hostname: "host" }, { type: "codex" }],
  ] as const)("caps %s runtime arrays at the shared maximum", (_name, schema, base, runtime) => {
    expect(schema.safeParse({
      ...base,
      runtimes: Array.from({ length: COMMUNITY_RUNTIME_LIST_MAX }, () => runtime),
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      runtimes: Array.from({ length: COMMUNITY_RUNTIME_LIST_MAX + 1 }, () => runtime),
    }).success).toBe(false);
  });
});
