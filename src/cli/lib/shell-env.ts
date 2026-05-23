import { execSync } from "child_process";
import { isWindows } from "./platform.js";

const PASSTHROUGH_VARS = ["ALOOK_PROJECT_ROOT", "ALOOK_SERVER_URL", "ALOOK_CMD_PREFIX", "ALOOK_HEALTH_PORT"];

export function resolveLoginShellEnv(): NodeJS.ProcessEnv {
  if (isWindows) {
    return { ...process.env };
  }

  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const output = execSync(`${shell} -ilc 'env'`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const env: NodeJS.ProcessEnv = {};
    for (const line of output.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    if (env.PATH) {
      for (const key of PASSTHROUGH_VARS) {
        if (process.env[key]) env[key] = process.env[key];
      }
      return env;
    }
  } catch {
    // fall through
  }
  return { ...process.env };
}
