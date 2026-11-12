import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("next/dist/bin/next")), "build"], {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, ALOOK_WEB_BUILD_ID: randomUUID() },
})
if (result.error) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
else {
  Object.assign(process.env, { NODE_ENV: "production" })
  void import("./stage-service-worker").then(({ stageServiceWorker }) => stageServiceWorker(webRoot))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
