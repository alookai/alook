import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["src/shared", "src/web", "src/cli", "src/email-worker", "src/ws-do", "src/app", "tests/utils"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx,js,jsx}"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/node_modules/**",
        "**/.next/**",
        "**/.open-next/**",
        "**/.wrangler/**",
        "**/dist/**",
        "**/bundled/**",
        "**/__mocks__/**",
        "**/*.d.ts",
        "src/cli/src/index.ts",
        "src/web/src/**/*.tsx",
      ],
    },
  },
})
