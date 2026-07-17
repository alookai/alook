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
        "src/web/scripts/**",
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
