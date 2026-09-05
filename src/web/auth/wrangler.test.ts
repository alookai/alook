import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");

describe("alook-auth Wrangler contract", () => {
  it("locks the standalone worker name and public surface", () => {
    expect(config).toContain('name = "alook-auth"');
    expect(config).toContain('main = "index.ts"');
    expect(config).toContain('pattern = "auth.alook.ai"');
    expect(config).toContain("custom_domain = true");
    expect(config).toContain("workers_dev = false");
    expect(config).toContain("preview_urls = false");
  });

  it("disables persisted, invocation, custom, and trace telemetry", () => {
    expect(config).toMatch(/\[observability\]\nenabled = false\nhead_sampling_rate = 0/);
    expect(config).toMatch(/\[observability\.logs\]\nenabled = false\ninvocation_logs = false\nhead_sampling_rate = 0/);
    expect(config).toMatch(/\[observability\.traces\]\nenabled = false\nhead_sampling_rate = 0/);
    expect(config).not.toContain("destinations");
  });

  it("declares no state, service, asset, queue, or secret bindings", () => {
    expect(config).not.toMatch(/\[(?:assets|vars|d1_databases|r2_buckets|kv_namespaces|services|queues|durable_objects|secrets)/);
  });
});
