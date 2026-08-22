import { describe, expect, it } from "vitest";
import { ClaudeTurnProtocol } from "./turnProtocol.js";

const uuidOf = (receipt: string) => receipt.slice("claude:".length);

describe("ClaudeTurnProtocol", () => {
  it("does not admit provider work for a new turn before its root replay acknowledgement", () => {
    const protocol = new ClaudeTurnProtocol();
    const root = uuidOf(protocol.beginTurn());
    expect(protocol.acceptsTurnWork()).toBe(false);
    protocol.acknowledge(root);
    expect(protocol.acceptsTurnWork()).toBe(true);
  });

  it("claims a root result after its provider acknowledgement", () => {
    const protocol = new ClaudeTurnProtocol();
    const receipt = protocol.beginTurn();
    const root = uuidOf(receipt);
    protocol.acknowledge(root);
    expect(protocol.claimResult(root)).toBe(receipt);
  });

  it("defers a root result until unacknowledged steering finishes a follow-on segment", () => {
    const protocol = new ClaudeTurnProtocol();
    const receipt = protocol.beginTurn();
    const root = uuidOf(receipt);
    const first = protocol.steeringInputUuid();
    const second = protocol.steeringInputUuid();
    protocol.acknowledge(root);

    expect(protocol.claimResult(root)).toBeNull();
    protocol.acknowledge(first);
    protocol.acknowledge(second);
    expect(protocol.claimResult(first)).toBeNull();
    expect(protocol.claimResult(second)).toBe(receipt);
  });

  it("keeps steering acknowledged before the root result inside that provider segment", () => {
    const protocol = new ClaudeTurnProtocol();
    const receipt = protocol.beginTurn();
    const root = uuidOf(receipt);
    const steering = protocol.steeringInputUuid();
    protocol.acknowledge(root);
    protocol.acknowledge(steering);
    expect(protocol.claimResult(root)).toBe(receipt);
  });

  it("suppresses a stale prior-turn result after the next logical turn begins", () => {
    const protocol = new ClaudeTurnProtocol();
    const first = uuidOf(protocol.beginTurn());
    const secondReceipt = protocol.beginTurn();
    const second = uuidOf(secondReceipt);
    expect(protocol.claimResult(first)).toBeNull();
    protocol.acknowledge(second);
    expect(protocol.claimResult(second)).toBe(secondReceipt);
  });
});
