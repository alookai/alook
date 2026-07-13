import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to sources as *.test.ts. Real-infra integration
    // tests live in ../../tests/integration/daemon/ and run separately via
    // `pnpm test:integration` (not part of this config's include).
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
