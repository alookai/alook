import { defineConfig, mergeConfig } from "vitest/config"
import { resolve } from "path"
import shared from "../../../vitest.shared"

const dir = resolve(import.meta.dirname)
const root = resolve(dir, "../../../")

export default mergeConfig(shared, defineConfig({
  resolve: {
    alias: {
      "@alook/test-utils": resolve(root, "tests/utils/src/index.ts"),
      "@alook/shared": resolve(root, "src/shared/src/index.ts"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [`${dir}/**/*.test.ts`],
    setupFiles: [`${dir}/setup.ts`],
    fileParallelism: false,
  },
}))
