import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readShellEnvironment } from "./shellEnvironment.js";
import { daemonProcessArguments, ownsDaemon } from "./daemonState.js";
import type { DaemonOwnerContext } from "./daemonOwnership.js";

type RefreshContext = DaemonOwnerContext;

export function createDaemonRefreshHandler(context: RefreshContext, options: {
  readEnvironment?: typeof readShellEnvironment;
  spawnProcess?: typeof spawn;
} = {}): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) return;
    if (!ownsDaemon(context)) throw new Error("ownership_changed");
    active = true;
    try {
      const environment = await (options.readEnvironment ?? readShellEnvironment)();
      if (!ownsDaemon(context)) throw new Error("ownership_changed");
      const priorEnvironment = { ...process.env };
      if (process.env.ALOOK_DAEMON_PACKAGE_WRAPPER) environment.ALOOK_DAEMON_PACKAGE_WRAPPER = process.env.ALOOK_DAEMON_PACKAGE_WRAPPER;
      if (process.env.NODE_ENV === "test") {
        for (const [key, value] of Object.entries(process.env)) {
          if (key === "NODE_ENV" || key.startsWith("ALOOK_DAEMON_TEST_")) environment[key] = value;
        }
      }
      const helper = (options.spawnProcess ?? spawn)(process.execPath, daemonProcessArguments("refresh-run"), {
        env: environment, cwd: process.cwd(), detached: true, windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      await new Promise<void>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("exit", (code) => code === 0 ? resolve() : reject(new Error("restart_failed")));
        helper.send!({ context, requestId: randomUUID(), priorEnvironment }, (error) => { if (error) reject(error); });
        helper.unref();
        helper.channel?.unref();
      });
    } finally { active = false; }
  };
}
