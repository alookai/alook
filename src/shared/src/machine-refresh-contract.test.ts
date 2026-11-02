import { describe, expect, it } from "vitest";
import { MachineRefreshCommandSchema, MachineRefreshRequestSchema, MachineRefreshResultSchema } from "./machine-refresh-contract";
import { HostCommandSchema } from "./community-cli-contract";
import { HostReadyMessageSchema } from "./schemas";

const requestId = "26aac14d-dfd6-4e96-821c-ebf538316f79";
describe("machine Refresh protocol", () => {
  it("permits only a UUID action and fixed result codes, never environment or command fields", () => {
    const command = { type: "machine:refresh", requestId };
    expect(HostCommandSchema.parse(command)).toEqual(command);
    expect(MachineRefreshCommandSchema.safeParse({ ...command, env: { SECRET: "private" } }).success).toBe(false);
    expect(MachineRefreshRequestSchema.safeParse({ requestId, command: "shell" }).success).toBe(false);
    expect(MachineRefreshRequestSchema.safeParse({ requestId: "arbitrary" }).success).toBe(false);
    expect(MachineRefreshResultSchema.safeParse({ requestId, status: "error", code: "raw exception" }).success).toBe(false);
  });
  it("retains request correlation in a new runner ready", () => {
    const refreshResult = { requestId, status: "complete" };
    expect(HostReadyMessageSchema.parse({ type: "ready", runtimeReport: [], refreshResult }).refreshResult).toEqual(refreshResult);
  });
});
