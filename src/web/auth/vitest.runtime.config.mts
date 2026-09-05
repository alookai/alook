import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    name: "auth-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    sequence: { groupOrder: 14 },
  },
});
