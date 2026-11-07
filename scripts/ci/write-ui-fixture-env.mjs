import { writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

export function writeUiFixtureEnv(path = fileURLToPath(new URL("../../src/web/.dev.vars", import.meta.url))) {
  writeFileSync(path, "BETTER_AUTH_SECRET=ci-e2e-ui-secret\nBETTER_AUTH_URL=http://localhost:3000\nENCRYPTION_KEY=ci-e2e-encryption-key-32chars!!\nDEV_WS_DO_URL=http://localhost:3000\nNODE_ENV=development\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeUiFixtureEnv()
