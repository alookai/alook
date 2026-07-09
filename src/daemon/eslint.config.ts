import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**", "coverage/**"]),
  {
    files: ["src/drivers/**/*.ts", "src/cli/proxyServerApi.ts", "src/server/contract.ts", "src/server/wsControlServer.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Drivers must spawn agent CLIs through `spawnAgentProcess` (src/runtime/killTree.ts)
    // so the detached-process-group contract killProcessTree relies on can't be
    // silently skipped by a new/edited driver — see plans/fix-daemon-agent-process-kill.md.
    files: ["src/drivers/**/*.ts"],
    ignores: ["src/drivers/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "child_process",
              importNames: ["spawn"],
              message:
                "Use spawnAgentProcess from '../runtime/killTree.js' instead — it guarantees the detached process-group contract killProcessTree relies on to actually terminate the process.",
            },
          ],
        },
      ],
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

export default eslintConfig;
