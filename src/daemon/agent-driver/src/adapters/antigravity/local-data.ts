import { spawnAgentProcess } from "../../internal/killTree.js";
import { runBoundedDiscoveryProcess } from "../../internal/discovery-process.js";

export async function readLocalCommand(command: string, args: string[], limit = 256 * 1024): Promise<string> {
  const child = spawnAgentProcess(command, args, { cwd: process.cwd(), env: process.env, shell: false, stdin: "ignore" });
  let output = "";
  return runBoundedDiscoveryProcess({
    process: child, label: "Local data", timeoutMs: 3_000, outputMaxBytes: limit,
    stderr: "ignore", cleanupGraceMs: 100, exitEvent: "close",
    onStdout: (text) => { output += text; },
    onExit: (code, _signal, control) => {
      if (code !== 0) return control.fail("Local data read failed");
      control.flushStdout();
      control.finish(output);
    },
  });
}
