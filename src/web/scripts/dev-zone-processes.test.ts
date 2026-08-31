import { describe, expect, it } from "vitest"
import { LOCAL_WORKER_ENDPOINTS, workerDevArgs } from "./dev-zone-processes.mjs"

describe("development zone Worker processes", () => {
  it("assigns independent request and inspector ports", () => {
    expect(LOCAL_WORKER_ENDPOINTS.main.port).not.toBe(LOCAL_WORKER_ENDPOINTS.blog.port)
    expect(LOCAL_WORKER_ENDPOINTS.main.inspectorPort).not.toBe(
      LOCAL_WORKER_ENDPOINTS.blog.inspectorPort,
    )
  })

  it("passes both ports explicitly to Wrangler", () => {
    expect(workerDevArgs("blog/wrangler.toml", LOCAL_WORKER_ENDPOINTS.blog)).toEqual([
      "exec",
      "wrangler",
      "dev",
      "--config",
      "blog/wrangler.toml",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "3002",
      "--inspector-port",
      "9230",
    ])
  })
})
