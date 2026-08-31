import { describe, expect, it } from "vitest"
import {
  exactWorkerDevArgs,
  LOCAL_WORKER_ENDPOINTS,
  workerDevArgs,
} from "./dev-zone-processes.mjs"

describe("development zone Worker processes", () => {
  it("assigns independent request, inspector, and persistence locations", () => {
    expect(LOCAL_WORKER_ENDPOINTS.main.port).not.toBe(LOCAL_WORKER_ENDPOINTS.blog.port)
    expect(LOCAL_WORKER_ENDPOINTS.main.inspectorPort).not.toBe(
      LOCAL_WORKER_ENDPOINTS.blog.inspectorPort,
    )
    expect(LOCAL_WORKER_ENDPOINTS.main.persistTo).not.toBe(
      LOCAL_WORKER_ENDPOINTS.blog.persistTo,
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
      "--persist-to",
      "blog/.wrangler/state",
      "--ip",
      "127.0.0.1",
      "--port",
      "3002",
      "--inspector-port",
      "9231",
      "--show-interactive-dev-session=false",
    ])
  })

  it("keeps main and ws-do in one exact Wrangler runtime for E2E", () => {
    expect(exactWorkerDevArgs(
      "/wrangler/bin/wrangler.js",
      ["wrangler.toml", "../ws-do/wrangler.toml"],
      LOCAL_WORKER_ENDPOINTS.main,
    )).toEqual([
      "/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "wrangler.toml",
      "--config",
      "../ws-do/wrangler.toml",
      "--local",
      "--persist-to",
      ".wrangler/state",
      "--ip",
      "127.0.0.1",
      "--port",
      "3001",
      "--inspector-port",
      "9229",
      "--show-interactive-dev-session=false",
    ])
  })
})
