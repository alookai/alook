import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "daemon-node",
    // Unit tests live next to sources as *.test.ts. Real-infra integration
    // tests live in ../../tests/integration/daemon/ and run separately via
    // `pnpm test:integration` (not part of this config's include).
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    // Process-authority fixtures send real signals. Keep daemon files serial
    // and out of the root workspace's concurrent project group.
    maxWorkers: 1,
    sequence: { groupOrder: 2 },
  },
});
