import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";

export async function readLocalCommand(command: string, args: string[], limit = 256 * 1024): Promise<string> {
  const child = spawnAgentProcess(command, args, { cwd: process.cwd(), env: process.env, shell: false, stdin: "ignore" });
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Local data read timed out")), 3_000);
      const fail = () => { clearTimeout(timer); reject(new Error("Local data read failed")); };
      child.on("error", fail);
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > limit) fail();
      });
      child.stderr?.on("data", () => {});
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else fail(); });
    });
  } finally {
    if (child.pid) await killProcessTree(child.pid, { graceMs: 100 });
  }
}
