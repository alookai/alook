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
    name: "web-node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "blog/**/*.test.ts", "readme-capture/**/*.test.ts"],
    exclude: ["src/test/e2e/**", "src/test/e2e-ui/**"],
  },
}))
