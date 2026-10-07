import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "@typescript-eslint/no-deprecated": "error" },
  },
];
