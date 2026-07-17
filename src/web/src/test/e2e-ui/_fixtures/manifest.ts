import { readFileSync } from "fs"
import { MANIFEST_PATH } from "../_setup/paths"
import type { RunManifest } from "../_setup/users"

let cached: RunManifest | null = null

export function manifest(): RunManifest {
  if (!cached) {
    cached = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RunManifest
  }
  return cached
}
