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
        // CSS selectors and XPath are against the selector policy
        // (docs/selectors-and-testid.md) and were not enforceable. Playwright
        // treats a locator string as CSS unless it is a `text=`-style
        // shorthand, so a literal first argument that is CSS or XPath is
        // exactly the misuse the docs ban, and it is detectable statically.
        // A variable or template argument is not (the code would have to be
        // evaluated); that gap is recorded in the docs. Positional `.nth()`
        // stays policy-only for now: banning it would have to cover
        // `.first()`/`.last()` too, which is a separate decision.
        {
          selector:
            "CallExpression[callee.property.name='locator'] > Literal[value=/^\\s*(\\/\\/|\\.\\/|\\.\\.|xpath=)/i]",
          message:
            "XPath is banned by the selector policy. Find the element by role, label, text or data-testid (docs/selectors-and-testid.md).",
        },
        {
          selector:
            "CallExpression[callee.property.name='locator'] > Literal[value=/[.#][A-Za-z_*]/]",
          message:
            "A CSS class or id selector is banned by the selector policy. Use getByRole/getByLabel/getByText/getByTestId (docs/selectors-and-testid.md).",
        },
        {
          selector:
            "CallExpression[callee.property.name='locator'] > Literal[value=/\\[[^\\]]+\\]/]",
          message:
            "A CSS attribute selector is banned by the selector policy. Read data-testid with getByTestId (docs/selectors-and-testid.md).",
        },
        {
          selector: "CallExpression[callee.property.name='locator'] > Literal[value=/[>+~]/]",
          message:
            "A CSS combinator is banned by the selector policy. Use getByRole/getByLabel/getByText/getByTestId (docs/selectors-and-testid.md).",
        },
        {
          selector:
            "CallExpression[callee.property.name='locator'] > Literal[value=/\\s/][value=/^[^=]*$/]",
          message:
            "A whitespace-separated CSS descendant selector is banned by the selector policy. Use getByText or getByRole (docs/selectors-and-testid.md).",
        },
        {
          selector: "CallExpression[callee.property.name='locator'] > Literal[value=/^\\s*text=/i]",
          message:
            "text= shorthand is banned by the selector policy: getByText reads the display text as the contract (docs/selectors-and-testid.md).",
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
