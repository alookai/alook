export const LOCAL_WORKER_ENDPOINTS = Object.freeze({
  main: Object.freeze({
    port: 3001,
    inspectorPort: 9229,
    persistTo: ".wrangler/state",
  }),
  blog: Object.freeze({
    port: 3002,
    inspectorPort: 9231,
    persistTo: "blog/.wrangler/state",
  }),
})

export function wranglerDevArgs(configPaths, endpoint) {
  const configs = Array.isArray(configPaths) ? configPaths : [configPaths]
  return [
    "dev",
    ...configs.flatMap((configPath) => ["--config", configPath]),
    "--local",
    "--persist-to",
    endpoint.persistTo,
    "--ip",
    "127.0.0.1",
    "--port",
    String(endpoint.port),
    "--inspector-port",
    String(endpoint.inspectorPort),
    "--show-interactive-dev-session=false",
  ]
}

export function workerDevArgs(configPaths, endpoint) {
  return ["exec", "wrangler", ...wranglerDevArgs(configPaths, endpoint)]
}

export function exactWorkerDevArgs(wranglerEntry, configPaths, endpoint) {
  return [wranglerEntry, ...wranglerDevArgs(configPaths, endpoint)]
}
