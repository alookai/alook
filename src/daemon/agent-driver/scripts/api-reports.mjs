import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = process.argv[2];
if (mode !== "check" && mode !== "update") {
  throw new Error("Usage: node scripts/api-reports.mjs <check|update>");
}

const reports = ["root", "host", "adapter-author", "testing"];
let failed = false;
for (const report of reports) {
  const configPath = resolve(packageRoot, `api-extractor.${report}.json`);
  const config = ExtractorConfig.loadFileAndPrepare(configPath);
  const result = Extractor.invoke(config, {
    localBuild: mode === "update",
    showDiagnostics: false,
    showVerboseMessages: false,
  });
  if (!result.succeeded) failed = true;
}

if (failed) process.exitCode = 1;
