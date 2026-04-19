import { Command } from "commander";
import { getCurrentVersion, fetchLatestVersion, runNpmUpdate } from "../lib/update.js";
import { semverGte } from "@alook/shared";

export function updateCommand(): Command {
  const cmd = new Command("update")
    .description("Update CLI to the latest version")
    .action(async () => {
      const current = getCurrentVersion();
      console.log(`Current version: ${current}`);

      const latest = await fetchLatestVersion();
      if (!latest) {
        console.error("Failed to fetch latest version from npm registry.");
        process.exit(1);
        return;
      }

      if (semverGte(current, latest)) {
        console.log(`Already up to date (v${current}).`);
        return;
      }

      // Check if daemon is running
      const healthPort = Number(process.env.ALOOK_HEALTH_PORT) || 19514;
      try {
        const res = await fetch(`http://127.0.0.1:${healthPort}/health`);
        if (res.ok) {
          console.warn(
            "Warning: daemon is running on the old version. After update, restart with: alook daemon restart",
          );
        }
      } catch {
        // daemon not running — fine
      }

      console.log(`Updating to v${latest}...`);
      const result = await runNpmUpdate(latest);
      if (result.success) {
        console.log(`Updated successfully: v${current} → v${latest}`);
      } else {
        console.error(`Update failed:\n${result.output}`);
        process.exit(1);
      }
    });

  return cmd;
}
