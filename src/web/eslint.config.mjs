import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";
import tailwindCanonicalClasses from "eslint-plugin-tailwind-canonical-classes";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tailwindCanonicalClasses.configs["flat/recommended"],
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "@typescript-eslint/no-deprecated": "error" },
  },
  {
    files: ["blog/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: { parserOptions: { project: "./blog/tsconfig.eslint.json" } },
  },
  {
    files: ["auth/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: { parserOptions: { project: "./auth/tsconfig.eslint.json" } },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "blog/.next/**",
    "app-store-capture/.next/**",
    "app-store-capture/next-env.d.ts",
    "blog/.open-next/**",
    "**/.wrangler/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
    "blog/cloudflare-env.d.ts",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/no-deriving-state-in-effects": "error",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "error",
      "react-hooks/exhaustive-deps": "error",
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
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    ignores: [
      "**/*.test.*",
      "**/*.spec.*",
      "src/test/**",
      "**/test-runtime/**",
    ],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name=/^(useEffect|useLayoutEffect)$/][arguments.length=1]",
          message: "Do not call useEffect/useLayoutEffect without a dependency array in production code.",
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(useEffect|useLayoutEffect)$/][arguments.length=1]",
          message: "Do not call React.useEffect/React.useLayoutEffect without a dependency array in production code.",
        },
      ],
    },
  },
  // TODO(#372): remove these temporary narrow overrides once /Alook#5620/fix/#372 lands.
  {
    files: ["src/hooks/community/use-conversation-entry.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["src/components/community/messages/message-list-controller.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: [
      "src/components/community/channels/forum-post-list.tsx",
      "src/hooks/community/use-scroll-anchor.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
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
