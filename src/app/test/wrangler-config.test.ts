import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { removeServiceBinding } from "../src/lib/wrangler-config";

const roots: string[] = [];
const ports = { web: 3000, emailWorker: 8788, wsDo: 8789, queueWorker: 8790 };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.doUnmock("../src/lib/constants.js");
  vi.resetModules();
});
async function patch(content: string) {
  const root = mkdtempSync(join(tmpdir(), "alook-app-wrangler-"));
  roots.push(root);
  for (const service of ["web", "email-worker", "ws-do", "queue-worker"]) {
    mkdirSync(join(root, service), { recursive: true });
    writeFileSync(join(root, service, "wrangler.toml"), content);
  }
  vi.resetModules();
  vi.doMock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: root }));
  const { patchWranglerConfigs } = await import("../src/lib/wrangler-config.js");
  patchWranglerConfigs(ports);
  return Object.fromEntries(["web", "email-worker", "ws-do", "queue-worker"].map(service => [service, readFileSync(join(root, service, "wrangler.toml"), "utf8")]));
}

describe("real self-hosted config file patching", () => {
  it("disables only Blog discovery while preserving the WS binding", async () => {
    const result = await patch('name = "web"\n[[services]]\nbinding = "WS_DO_WORKER"\nservice = "alook-ws-do"\n\n[[services]]\nbinding = "BLOG_WORKER"\nservice = "alook-blog"\n\n[vars]\nBLOG_DISCOVERY_REQUIRED = "true"\n');
    expect(result.web).toContain('BLOG_DISCOVERY_REQUIRED = "false"');
    expect(result.web).not.toContain('binding = "BLOG_WORKER"');
    expect(result.web).toContain('binding = "WS_DO_WORKER"');
    expect(result.web).toContain('service = "alook-ws-do"');
  });
  it.each([
    ['existing variable', '[vars]\nDEV_WS_DO_URL = "http://localhost:9999"'],
    ['existing vars section', 'name = "web"\n[vars]\nFOO = "bar"'],
    ['missing vars', 'name = "web"\n[dev]\nport = 9999'],
    ['empty config', ''],
  ])("writes real service URLs for %s", async (_name, content) => {
    const result = await patch(content);
    expect(result.web).toContain('DEV_WS_DO_URL = "http://localhost:8789"');
    expect(result.web).toContain('DEV_EMAIL_WORKER_URL = "http://localhost:8788"');
    expect(result.web).toContain('DEV_QUEUE_WORKER_URL = "http://localhost:8790"');
    expect(result.web).not.toContain('http://localhost:9999');
    expect(result.web).toContain('NODE_ENV = "development"');
    if (content.includes('FOO')) expect(result.web).toContain('FOO = "bar"');
  });
  it.each([
    ['inspector first', '[dev]\ninspector_port = 7\nport = 9999\n'],
    ['port first', '[dev]\nport = 9999\ninspector_port = 7\n'],
    ['inspector only', '[dev]\ninspector_port = 7\n'],
    ['port only', '[dev]\nport = 9999\n'],
    ['missing dev', 'name = "service"\n'],
    ['duplicate keys', '[dev]\nport = 1\ninspector_port = 2\nport = 9999\ninspector_port = 7\n[vars]\nFOO = "bar"\n'],
  ])("patches the actual four files with %s", async (_name, content) => {
    const result = await patch(content);
    for (const [directory, port, inspector] of [['web', 3000, 19229], ['email-worker', 8788, 19231], ['ws-do', 8789, 19230], ['queue-worker', 8790, 19232]] as const) {
      expect(result[directory].match(/^port\s*=.*$/gm)).toEqual([`port = ${port}`]);
      expect(result[directory].match(/^inspector_port\s*=.*$/gm)).toEqual([`inspector_port = ${inspector}`]);
      if (content.includes('FOO')) expect(result[directory]).toContain('FOO = "bar"');
    }
  });
  describe("removeServiceBinding", () => {
    it("removes only the Blog service binding for self-hosting", () => {
      const content = `name = "web"
[[services]]
binding = "WS_DO_WORKER"
service = "alook-ws-do"

[[services]]
binding = "BLOG_WORKER"
service = "alook-blog"

[vars]
BLOG_DISCOVERY_REQUIRED = "true"
`;

      const result = removeServiceBinding(content, "BLOG_WORKER");

      expect(result).not.toContain('binding = "BLOG_WORKER"');
      expect(result).not.toContain('service = "alook-blog"');
      expect(result).toContain('binding = "WS_DO_WORKER"');
      expect(result).toContain("[vars]");
    });
  });


});
