import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/** Node globals the plain JavaScript scripts (`*.mjs`) use. */
const nodeGlobals = {
  Buffer: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setTimeout: "readonly",
};

export default defineConfig([
  globalIgnores(["node_modules/**"]),
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", caughtErrors: "all", varsIgnorePattern: "^_$", argsIgnorePattern: "^_$" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { sourceType: "module", globals: nodeGlobals },
    rules: {
      "no-unused-vars": ["error", { args: "all", caughtErrors: "all", varsIgnorePattern: "^_$", argsIgnorePattern: "^_$" }],
    },
  },
]);
