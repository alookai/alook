import { spawn } from "node:child_process"
import { resolve } from "node:path"

const [registryPath, command, ...args] = process.argv.slice(2)
const packageManagerCli = process.env.npm_execpath

if (!registryPath || !command || !packageManagerCli) {
  throw new Error("usage: dev-with-wrangler-registry <registry-path> <command> [...args]")
}

const child = spawn(
  packageManagerCli,
  ["exec", command, ...args],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_REGISTRY_PATH: resolve(process.cwd(), registryPath),
    },
  },
)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal))
}

child.once("error", (error) => {
  console.error(error)
  process.exitCode = 1
})

child.once("exit", (code) => {
  process.exitCode = code ?? 1
})
