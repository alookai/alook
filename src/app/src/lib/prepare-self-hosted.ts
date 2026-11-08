import type { DevPortProfile } from "@alook/shared";
import { SELF_HOSTED_DIR } from "./constants.js";
import { assertInstallationComplete, getMissingInstallFiles, installBundled, isInstalled } from "./install.js";
import { ensureSecrets } from "./secrets.js";
import { patchWranglerConfigs } from "./wrangler-config.js";
import { runMigrations } from "./migrate.js";

export function prepareSelfHosted(ports: DevPortProfile, replaceInstallation = false): void {
  if (replaceInstallation) {
    console.log("Installing latest version...");
    installBundled();
  } else if (!isInstalled()) {
    console.log(`Installing missing Alook files (${getMissingInstallFiles().length} required files missing)...`);
    installBundled();
  } else {
    console.log(`Installation found at ${SELF_HOSTED_DIR}`);
  }
  assertInstallationComplete();
  ensureSecrets(ports.web);
  patchWranglerConfigs(ports);
  if (replaceInstallation) console.log("Running migrations...");
  runMigrations();
}
