import baseConfig from "../eslint.config.js";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...baseConfig,
  {
    files: ["src/adapters/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/adapters/**/*.ts"],
    ignores: ["src/adapters/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["child_process", "node:child_process"].map((name) => ({
            name,
            message:
              "Do not import child_process in production adapters. Use the agent-driver process helpers so every agent CLI retains the shared process-tree teardown contract.",
          })),
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...["child_process", "node:child_process"].flatMap((name) => [
          {
            selector: `ImportExpression[source.value='${name}']`,
            message:
              "Do not dynamically import child_process in production adapters. Use the agent-driver process helpers.",
          },
          {
            selector: `CallExpression[callee.name='require'][arguments.0.value='${name}']`,
            message:
              "Do not require child_process in production adapters. Use the agent-driver process helpers.",
          },
        ]),
      ],
    },
  },
  {
    files: ["src/contract.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "off",
    },
  },
]);
