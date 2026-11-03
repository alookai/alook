import { copyFileSync, mkdirSync, readFileSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
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
    /* istanbul ignore if */
    if (!readFileSync(source).equals(readFileSync(destination))) {
      throw new Error(`Staged Blog asset differs from canonical source: ${asset.source}`);
    }
  }

  const nestedPackageManifest = resolve(webRoot, "blog/package.json");
  const nestedPackage = lstatSync(nestedPackageManifest, { throwIfNoEntry: false });
  if (nestedPackage) {
    if (!nestedPackage.isSymbolicLink() || readlinkSync(nestedPackageManifest) !== "../package.json") {
      throw new Error("Unexpected nested Blog package manifest");
    }
    unlinkSync(nestedPackageManifest);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
/* istanbul ignore if */
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  stageSharedBlogAssets(resolve(dirname(scriptPath), "../.."));
  console.log(`Staged ${sharedBlogAssets.length} canonical assets for the Blog build.`);
}
