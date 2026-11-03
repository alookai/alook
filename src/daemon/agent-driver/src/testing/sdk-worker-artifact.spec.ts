import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export async function buildSdkWorkerArtifact() {
  const root = mkdtempSync(join(tmpdir(), "alook-sdk-worker-build-"));
  const dispose = () => rmSync(root, { recursive: true, force: true });
  try {
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const require = createRequire(import.meta.url);
    await promisify(execFile)(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", root, "--sourceMap", "false", "--declarationMap", "false"], { cwd: packageRoot });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    const load = (url: string): Promise<unknown> => import(url);
    const [lane, driver, qoder, copilot, cursor, pi] = await Promise.all([
      load(pathToFileURL(join(root, "internal/sdk-worker-lane.js")).href) as Promise<typeof import("../internal/sdk-worker-lane.js")>,
      load(pathToFileURL(join(root, "internal/optional-sdk-driver.js")).href) as Promise<typeof import("../internal/optional-sdk-driver.js")>,
      load(pathToFileURL(join(root, "adapters/qoder/worker.js")).href) as Promise<typeof import("../adapters/qoder/worker.js")>,
      load(pathToFileURL(join(root, "adapters/copilot/worker.js")).href) as Promise<typeof import("../adapters/copilot/worker.js")>,
      load(pathToFileURL(join(root, "adapters/cursor-sdk/worker.js")).href) as Promise<typeof import("../adapters/cursor-sdk/worker.js")>,
      load(pathToFileURL(join(root, "adapters/pi-durable/worker.js")).href) as Promise<typeof import("../adapters/pi-durable/worker.js")>,
    ]);
    return { ...lane, ...driver, ...qoder, ...copilot, ...cursor, ...pi, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
