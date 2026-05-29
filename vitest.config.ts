import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["src/shared", "src/web", "src/cli", "src/email-worker", "src/app", "tests/utils"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx,js,jsx}"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/node_modules/**",
        "**/.next/**",
        "**/dist/**",
        "**/bundled/**",
        "src/cli/src/index.ts",
      ],
    },
  },
})
