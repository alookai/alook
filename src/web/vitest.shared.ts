import path from "node:path"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"
import shared from "../../vitest.shared"

export function webTestConfig(config: ViteUserConfig) {
  return mergeConfig(mergeConfig(shared, defineConfig({
    root: import.meta.dirname,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@blog": path.resolve(import.meta.dirname, "blog/src"),
        "#open-next-worker": path.resolve(import.meta.dirname, "src/test-runtime/open-next-node-stub.ts"),
        "./.open-next/server-functions/default/src/web/.next/required-server-files.json": path.resolve(import.meta.dirname, "test-runtime/next-config-stub.json"),
      },
    },
    test: { testTimeout: 30_000, hookTimeout: 30_000 },
  })), config)
}
