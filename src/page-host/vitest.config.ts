import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"
export default mergeConfig(shared, defineConfig({ test: { name: "page-host", include: ["src/**/*.test.mjs"] } }))
