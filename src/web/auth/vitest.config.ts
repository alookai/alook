import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../../vitest.shared";

export default mergeConfig(shared, defineConfig({
  root: import.meta.dirname,
  test: {
    name: "auth-node",
    include: ["**/*.test.ts"],
    exclude: ["test-runtime/**"],
    sequence: { groupOrder: 2 },
  },
}));
