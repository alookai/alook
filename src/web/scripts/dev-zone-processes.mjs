export const LOCAL_WORKER_ENDPOINTS = Object.freeze({
  main: Object.freeze({ port: 3001, inspectorPort: 9229 }),
  blog: Object.freeze({ port: 3002, inspectorPort: 9230 }),
})

export function workerDevArgs(configPath, endpoint) {
  return [
    "exec",
    "wrangler",
    "dev",
    "--config",
    configPath,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(endpoint.port),
    "--inspector-port",
    String(endpoint.inspectorPort),
  ]
}
