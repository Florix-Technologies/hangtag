// Lint for the app's ES modules: catches names that are used but never defined or imported
// (the bundle check can't: an undefined name is just a global to it) and imports that are never used.
import globals from "globals";

export default [
  // vendored third-party code is kept exactly as published
  { ignores: ["src/**/vendor/**"] },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, supabase: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
    },
  },
];
