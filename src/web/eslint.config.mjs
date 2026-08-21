import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tailwindCanonicalClasses from "eslint-plugin-tailwind-canonical-classes";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tailwindCanonicalClasses.configs["flat/recommended"],
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "warn",
      "react/jsx-child-element-spacing": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "tailwind-canonical-classes/tailwind-canonical-classes": [
        "warn",
        { cssPath: "./src/app/globals.css" },
      ],
      "@next/next/no-img-element": "off",
      "@next/next/no-before-interactive-script-outside-document": "off",
    },
  },
  {
    files: ["src/platform/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/**", "@/lib/community/**", "@/components/community/**", "@/hooks/community/**", "@/stores/community/**", "**/modules/**", "**/lib/community/**", "**/components/community/**", "**/hooks/community/**", "**/stores/community/**"],
              message: "Platform client code cannot depend on product modules or Community ownership.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/community/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/platform/server", "@/platform/server/**", "@/modules/community/server", "@/modules/community/server/**", "**/server", "**/server/**", "cloudflare:*", "@cloudflare/**", "wrangler", "@opennextjs/cloudflare"],
              message: "Community client code cannot import server or Cloudflare capabilities.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/c/community-shell.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/community/client/**"],
              message: "App routes and shells must import the Community client public entry.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/modules/community/client/channel/**",
      "src/modules/community/client/messaging/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/community/client/**/internal/**"],
              message: "Community module internals are private; use a public entry.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/community/client/channel/internal/*-view.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next/navigation", "@tanstack/react-query", "@/hooks/community/**", "@/stores/community/**", "@/lib/api/**"],
              message: "Channel Views are prop-only; client capabilities belong in Controllers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.integration.test.ts",
      "lib/db/test-utils.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
]);

export default eslintConfig;
