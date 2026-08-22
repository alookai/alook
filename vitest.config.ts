import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "src/shared",
      "src/web",
      "src/cli",
      "src/daemon",
      "src/daemon/agent-driver",
      "src/email-worker",
      "src/ws-do",
      "src/wake-worker",
      "src/app",
      "tests/utils",
      "scripts/ci",
      "src/ws-do/vitest.runtime.config.mts",
      "src/email-worker/vitest.runtime.config.mts",
      "src/wake-worker/vitest.runtime.config.mts",
      "src/web/vitest.runtime.config.mts",
    ],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx,js,jsx}", "scripts/ci/**/*.mjs"],
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
        "**/test-harness.ts",
        "**/*.d.ts",
        "**/test-runtime/**",
        "src/cli/src/index.ts",
        "src/web/scripts/**",
        "src/web/readme-capture/**",
        "src/web/src/**/*.tsx",
        // React hooks (useEffect/useState/render-time refs) with no jsdom/RTL
        // test path — excluded for the same reason as the .tsx exclude above.
        // Their pure helpers are covered via separate unit tests where extracted
        // (e.g. chat-message-utils.ts, which IS covered). Listed individually
        // (not a blanket hooks glob) so genuinely-testable non-React hooks stay
        // included.
        "src/web/src/hooks/use-agent-chat.ts",
        "src/web/src/hooks/use-chat-sheets.ts",
        "src/web/src/hooks/use-file-attachments.ts",
        "src/web/src/hooks/use-message-flags.ts",
        "src/web/src/hooks/use-text-selection-quote.ts",
        "src/web/src/components/agent-chat/use-rotating-placeholder.ts",
      ],
    },
  },
})
