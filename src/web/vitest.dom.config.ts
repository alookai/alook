import path from "path"
import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@blog": path.resolve(__dirname, "blog/src"),
      "./.open-next/worker.js": path.resolve(__dirname, "src/test-runtime/open-next-node-stub.ts"),
    },
  },
  test: {
    name: "web-dom",
    environment: "jsdom",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["**/*.dom.test.{ts,tsx}"],
    exclude: ["src/test/e2e/**", "src/test/e2e-ui/**"],
    setupFiles: ["src/test/react-dom-setup.ts"],
  },
}))
