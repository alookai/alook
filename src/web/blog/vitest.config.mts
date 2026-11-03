import { defineConfig, mergeConfig } from "vitest/config"
import { blogTestConfig } from "./vitest.shared.mjs"

export default defineConfig(async () => mergeConfig(await blogTestConfig(), defineConfig({
  test: {
    name: "blog-node",
    include: ["**/*.test.ts"],
    exclude: ["**/*.dom.test.{ts,tsx}", "node_modules/**", ".next/**", ".open-next/**"],
  },
})))
