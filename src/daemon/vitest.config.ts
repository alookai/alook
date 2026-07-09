import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to sources as *.test.ts; e2e tests under test/e2e.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // e2e tests spin up real ws servers; give them room but keep unit tests fast.
    testTimeout: 10_000,
  },
});
