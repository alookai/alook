import { execSync } from "child_process";
import { join } from "path";
import { SELF_HOSTED_DIR } from "./constants.js";

export function runMigrations(): void {
  const webDir = join(SELF_HOSTED_DIR, "web");
  console.log("Running database migrations...");
  try {
    execSync("npx wrangler d1 migrations apply alook-app --local", {
      cwd: webDir,
      stdio: "inherit",
    });
    console.log("Migrations complete");
  } catch (err) {
    console.error("Error: failed to run migrations");
    process.exit(1);
  }
}
