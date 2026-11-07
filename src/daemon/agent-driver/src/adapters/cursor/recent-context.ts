import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import type { DiscoveryProcessDependencies } from "../../internal/discovery-process.js";
import { discoverAcpRecentContext } from "../../internal/acp-recent-context.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { resolveSpawnSpec } from "../../internal/probe.js";

export async function discoverCursorRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: DiscoveryProcessDependencies = {},
): Promise<RecentContextDiscoveryData> {
  return discoverAcpRecentContext(request, {
    label: "Cursor",
    authMethodId: "cursor_login",
    spawn: () => {
      const spec = resolveSpawnSpec("cursor-agent", ["acp"], request.command);
      return (dependencies.spawn ?? spawnAgentProcess)(spec.command, spec.args, {
        cwd: dependencies.cwd ?? process.cwd(),
        env: { ...process.env, CI: "1" },
        shell: spec.shell,
      });
    },
  }, dependencies);
}
