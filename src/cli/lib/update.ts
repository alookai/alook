import { spawn } from "child_process";
import { getCurrentVersion } from "./version.js";

export { getCurrentVersion };

export function fetchLatestVersion(): Promise<string | null> {
  return fetch("https://registry.npmjs.org/@alook/cli/latest")
    .then((res) => {
      if (!res.ok) return null;
      return res.json() as Promise<{ version?: string }>;
    })
    .then((data) => data?.version ?? null)
    .catch(() => null);
}

export function runNpmUpdate(
  targetVersion: string,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn("npm", ["install", "-g", `@alook/cli@${targetVersion}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (err) => {
      resolve({ success: false, output: err.message });
    });
    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString();
      resolve({ success: code === 0, output });
    });
  });
}
