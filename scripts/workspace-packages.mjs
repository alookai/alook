import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function workspacePackageRoots(root) {
  return [...readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8")
    .matchAll(/^[ ]{2}- ["']([^"']+)["']$/gm)]
    .map((match) => match[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""))
}
