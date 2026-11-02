import { describe, expect, it } from "vitest";
import { MachineRefreshCommandSchema } from "./machine-refresh-contract";
import { HostCommandSchema } from "./community-cli-contract";

describe("machine Refresh protocol", () => {
  it("permits only the fixed command, never environment, executable or remote correlation", () => {
    const command = { type: "machine:refresh" };
    expect(HostCommandSchema.parse(command)).toEqual(command);
    for (const field of [{ env: { SECRET: "private" } }, { command: "shell" }, { requestId: "arbitrary" }]) {
      expect(MachineRefreshCommandSchema.safeParse({ ...command, ...field }).success).toBe(false);
    }
  });
});
