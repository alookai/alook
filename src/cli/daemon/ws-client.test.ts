import { describe, it, expect, vi } from "vitest";
import { DaemonWsClient } from "./ws-client.js";

describe("DaemonWsClient", () => {
  it("constructs production URL correctly", () => {
    const client = new DaemonWsClient({
      serverURL: "https://alook.ai",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.getUrl()).toBe("wss://alook.ai/api/ws/daemon?daemonId=my-host");
  });

  it("constructs local development URL correctly", () => {
    const client = new DaemonWsClient({
      serverURL: "http://localhost:3000",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.getUrl()).toBe("ws://localhost:8789/?daemonId=my-host");
  });

  it("reports disconnected initially", () => {
    const client = new DaemonWsClient({
      serverURL: "https://alook.ai",
      daemonId: "my-host",
      machineToken: "al_test123",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    expect(client.isConnected()).toBe(false);
  });
});
