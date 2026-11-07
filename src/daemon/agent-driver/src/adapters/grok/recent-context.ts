import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import type { DiscoveryProcessDependencies } from "../../internal/discovery-process.js";
import { discoverAcpRecentContext } from "../../internal/acp-recent-context.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { resolveSpawnSpec } from "../../internal/probe.js";

export async function discoverGrokRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: DiscoveryProcessDependencies = {},
): Promise<RecentContextDiscoveryData> {
  return discoverAcpRecentContext(request, {
    label: "Grok",
    authMethodId: "cached_token",
    spawn: () => {
      const spec = resolveSpawnSpec("grok", ["agent", "--no-leader", "stdio"], request.command);
      return (dependencies.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
        cwd: dependencies.cwd ?? process.cwd(),
        env: { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" },
        shell: spec.shell,
      });
    },
  }, dependencies);
}
