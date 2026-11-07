import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { writeUiFixtureEnv } from "./write-ui-fixture-env.mjs"

it("writes the exact UI build input consumed by every artifact verifier", () => {
  const directory = mkdtempSync(join(tmpdir(), "alook-ui-fixture-"))
  try {
    const path = join(directory, ".dev.vars")
    writeUiFixtureEnv(path)
    expect(readFileSync(path, "utf8")).toBe([
      "BETTER_AUTH_SECRET=ci-e2e-ui-secret",
      "BETTER_AUTH_URL=http://localhost:3000",
      "ENCRYPTION_KEY=ci-e2e-encryption-key-32chars!!",
      "DEV_WS_DO_URL=http://localhost:3000",
      "NODE_ENV=development",
      "",
    ].join("\n"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
