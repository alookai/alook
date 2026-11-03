import path from "node:path"
import { defineConfig, mergeConfig } from "vitest/config"
import { blogTestConfig } from "./vitest.shared.mjs"

export default defineConfig(async () => mergeConfig(await blogTestConfig(), defineConfig({
  test: {
    name: "blog-dom",
    environment: "jsdom",
    include: ["**/*.dom.test.{ts,tsx}"],
    setupFiles: [path.resolve(import.meta.dirname, "../src/test/react-dom-setup.ts")],
  },
})))
