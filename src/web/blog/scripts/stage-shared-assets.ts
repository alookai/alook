import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharedBuildInputs from "../shared-build-inputs.json";

export const sharedBlogAssets = sharedBuildInputs.assets;

export function stageSharedBlogAssets(webRoot: string): void {
  for (const asset of sharedBlogAssets) {
    const source = resolve(webRoot, asset.source);
    const destination = resolve(webRoot, asset.destination);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (!readFileSync(source).equals(readFileSync(destination))) {
      throw new Error(`Staged Blog asset differs from canonical source: ${asset.source}`);
    }
  }

  const packageManifest = resolve(webRoot, "package.json");
  const nestedPackageManifest = resolve(webRoot, "blog/package.json");
  if (!existsSync(nestedPackageManifest)) {
    symlinkSync("../package.json", nestedPackageManifest, "file");
  }
  if (!readFileSync(packageManifest).equals(readFileSync(nestedPackageManifest))) {
    throw new Error("Nested Blog package pointer differs from the canonical Web package manifest");
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  stageSharedBlogAssets(resolve(dirname(scriptPath), "../.."));
  console.log(`Staged ${sharedBlogAssets.length} canonical assets for the Blog build.`);
}
