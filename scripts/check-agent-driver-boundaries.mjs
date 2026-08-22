import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const daemonSource = join(root, "src/daemon/src");
const violations = [];

function visit(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      visit(path);
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (readFileSync(path, "utf8").includes("@alook/agent-driver/adapter-author")) {
      violations.push(relative(root, path));
    }
  }
}

visit(daemonSource);
if (violations.length > 0) {
  console.error(`Daemon production must not import adapter-author:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("agent-driver production import boundary: PASS");
