import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import {
  type DiscoveryProcessDependencies,
  runBoundedDiscoveryProcess,
} from "../../internal/discovery-process.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { resolveSpawnSpec } from "../../internal/probe.js";
import { RecentContextCollector } from "../../internal/recent-context.js";
import { asRecord } from "../../internal/utils.js";
import { OPEN_CODE_V1, type OpenCodeCompatibility } from "./compatibility.js";

const OPENCODE_DISCOVERY_TIMEOUT_MS = 15_000;
const OPENCODE_DISCOVERY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

interface OpenCodeRecentContextDependencies extends DiscoveryProcessDependencies {
  readonly compatibility?: OpenCodeCompatibility;
}

interface CommandOutput {
  readonly output: string;
  readonly outputBytes: number;
}

function collectCommandOutput(
  command: string,
  args: string[],
  shell: boolean,
  dependencies: OpenCodeRecentContextDependencies,
  timeoutMs: number,
  outputMaxBytes: number,
): Promise<CommandOutput> {
  const processHandle = (dependencies.spawn ?? spawnAgentProcess)(command, args, {
    cwd: dependencies.cwd ?? process.cwd(),
    env: { ...process.env, CI: "1" },
    shell,
    stdin: "ignore",
  });

  let output = "";
  return runBoundedDiscoveryProcess({
    process: processHandle,
    label: "OpenCode",
    timeoutMs,
    outputMaxBytes,
    cleanup: dependencies.cleanup,
    exitEvent: "close",
    onStdout: (text) => { output += text; },
    onExit: (code, _signal, control) => {
      if (code !== 0) return control.fail("OpenCode session listing failed");
      control.flushStdout();
      control.finish({ output, outputBytes: control.outputBytes });
    },
  });
}

export async function discoverOpenCodeRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: OpenCodeRecentContextDependencies = {},
): Promise<RecentContextDiscoveryData> {
  const collector = new RecentContextCollector(request, "unavailable");
  if (collector.satisfied) return collector.result();
  const compatibility = dependencies.compatibility ?? OPEN_CODE_V1;
  const startedAt = Date.now();
  const timeoutMs = dependencies.timeoutMs ?? OPENCODE_DISCOVERY_TIMEOUT_MS;
  let remainingOutputBytes = dependencies.outputMaxBytes ?? OPENCODE_DISCOVERY_OUTPUT_MAX_BYTES;
  let maxCount = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, request.recentProjectsTopK * 10));
  while (!collector.satisfied) {
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) throw new Error("OpenCode discovery timed out");
    const spec = resolveSpawnSpec(
      "opencode",
      [...compatibility.sessionListArgs(maxCount)],
      request.command,
    );
    const commandOutput = await collectCommandOutput(
      spec.command,
      spec.args,
      spec.shell,
      dependencies,
      remainingTimeoutMs,
      remainingOutputBytes,
    );
    remainingOutputBytes -= commandOutput.outputBytes;
    let parsed: unknown;
    try {
      parsed = JSON.parse(commandOutput.output);
    } catch {
      throw new Error("OpenCode session listing returned invalid JSON");
    }
    if (compatibility.major === 2) parsed = asRecord(parsed)?.data;
    if (!Array.isArray(parsed)) throw new Error("OpenCode session listing returned an invalid response");
    for (const value of parsed) {
      const session = asRecord(value);
      if (!session) continue;
      const modifiedAt = compatibility.major === 2 ? asRecord(session.time)?.updated : session.updated ?? session.updatedAt;
      const projectPath = compatibility.major === 2 ? asRecord(session.location)?.directory : session.directory;
      collector.add({ projectPath, modifiedAt });
    }
    if (collector.satisfied || parsed.length < maxCount) break;
    const nextMaxCount = Math.min(Number.MAX_SAFE_INTEGER, maxCount * 2);
    if (nextMaxCount === maxCount) throw new Error("OpenCode session listing could not prove the requested Top-K");
    maxCount = nextMaxCount;
  }
  return collector.result();
}
