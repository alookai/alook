import { describe, it, expect } from "vitest";
import { MockServer } from "./mockServer";

/**
 * Enrollment surface: a machine exchanges its tier-1 machine key for a per-agent
 * tier-2 runner key. Authed by the machineKey — NOT agent voucher, NOT admin.
 */
async function withAgent() {
  const s = new MockServer();
  const { user } = await s.createUser({ name: "u" });
  const { agent } = await s.createAgent({ userId: user.id, name: "cindy", runtime: "mock" });
  return { s, agentId: agent.id };
}

describe("MockServer enrollment (machine credential surface)", () => {
  it("enrollMachine issues an sk_machine_ key the server then trusts", () => {
    const s = new MockServer();
    const key = s.enrollMachine();
    expect(key.startsWith("sk_machine_")).toBe(true);
    expect(s.verifyMachineKey(key)).toBe(true);
    expect(s.verifyMachineKey("sk_machine_forged")).toBe(false);
    expect(s.verifyMachineKey(undefined)).toBe(false);
  });

  it("mints an sk_agent_ runner key for a valid machine key + known agent", async () => {
    const { s, agentId } = await withAgent();
    const machineKey = s.enrollMachine();
    const { runnerKey } = await s.mintAgentCredential({ machineKey, agentId });
    expect(runnerKey.startsWith("sk_agent_")).toBe(true);
    // Each mint is distinct (per-agent, revocable tier-2 material).
    const again = await s.mintAgentCredential({ machineKey, agentId });
    expect(again.runnerKey).not.toBe(runnerKey);
  });

  it("rejects an unknown machine key (does not mint)", async () => {
    const { s, agentId } = await withAgent();
    await expect(s.mintAgentCredential({ machineKey: "sk_machine_forged", agentId })).rejects.toThrow(
      /machine key/i,
    );
  });

  it("rejects minting for an unknown agent", async () => {
    const s = new MockServer();
    const machineKey = s.enrollMachine();
    await expect(s.mintAgentCredential({ machineKey, agentId: "agent_nope" })).rejects.toThrow(/not found/i);
  });
});
