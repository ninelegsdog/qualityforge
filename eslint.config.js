// ESLint flat config (ESLint 9+).
// Typescript type-aware linting, including the rule that catches
// forgotten awaits on Playwright calls - the single most common
// source of silently broken tests.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "artifacts/**",
      "test-results/**",
      "playwright-report/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten await on a Playwright call makes the test lie.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // page.waitForTimeout() is the root cause of most flakiness.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='waitForTimeout'] > MemberExpression[object.property.name='page']",
          message:
            "page.waitForTimeout() is banned: it is the main source of flaky tests. Wait for a real condition — expect(locator).toBeVisible(), or waitForResponse/waitForURL.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "test",
          property: "only",
          message: "test.only() must not be committed: CI would silently skip tests.",
        },
        {
          object: "describe",
          property: "only",
          message: "describe.only() must not be committed: CI would silently skip tests.",
        },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The fixture web server is plain Node ESM, not part of the TS project.
    // Spread first so the explicit settings below win: ESLint flat config has
    // no implicit globals, so the ones this file uses must be declared.
    files: ["scripts/**/*.mjs", "fixtures/**/*.js", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // These files are plain Node ESM and are deliberately outside the
      // TypeScript project, so type-aware linting must be switched off for
      // them rather than force-added to tsconfig.
      parserOptions: {
        projectService: false,
        project: false,
      },
      globals: {
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
