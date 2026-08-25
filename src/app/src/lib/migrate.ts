import { execFileSync } from "child_process";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";
import { wranglerProcess } from "./wrangler.js";

export function runMigrations(): void {
  const webDir = join(SELF_HOSTED_DIR, "web");
  console.log("Running database migrations...");
  try {
    const wrangler = wranglerProcess(["d1", "migrations", "apply", "alook-app", "--local"]);
    const output = execFileSync(wrangler.command, wrangler.args, {
      cwd: webDir,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    const text = output.toString();
    const applied = text.match(/(\d+) commands? executed successfully/g);
    if (applied) {
      const total = applied.reduce((sum, m) => sum + Number(m.match(/\d+/)?.[0] ?? 0), 0);
      console.log(`  ✓ ${total} migration commands applied`);
    } else if (text.includes("No migrations to apply")) {
      console.log("  ✓ Already up to date");
    } else {
      console.log("  ✓ Migrations complete");
    }
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr) console.error(stderr);
    else console.error(err instanceof Error ? err.message : String(err));
    throw new Error("failed to run migrations");
  }
}
