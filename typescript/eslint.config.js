// @ts-check
//
// The lint layer the other two SDKs already had and this one did not: Rust runs
// `clippy -D warnings`, Python runs `ruff`, and TypeScript ran only `tsc`.
//
// `tsc --strict` already covers most of what clippy's correctness lints cover,
// so what is selected here is the part it does NOT see: values discarded at
// runtime (floating promises, unawaited thenables), `any` leaking through a
// boundary and silently disabling checking downstream, and dead bindings. These
// are the failure modes that matter in a client library — a dropped promise in
// the mux is a lost frame, and an `any` in a codec is an unchecked field.
//
// Stylistic rules are deliberately absent. There is no formatter here yet, so a
// style ruleset would flag hand-formatting the codebase already applies
// consistently, and the noise would bury the correctness findings.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `tsconfig.json` includes only `src/**`, so the type-aware rules would
        // fail to resolve every test file. `tsconfig.test.json` extends it and
        // adds `test/**`, which is the same project `npm run typecheck` uses —
        // so lint and typecheck see one program, not two.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in a client library is a lost frame or a swallowed
      // error, not a style question.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // An unused binding is usually a half-finished edit. `_`-prefixed names
      // are the escape hatch, matching Rust's `_x` convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Build config lives outside `tsconfig.test.json`'s program, so the
    // type-aware rules have no types to work from and the parser errors out.
    // Syntactic linting still applies.
    files: ["*.config.js", "*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { project: null } },
  },
  {
    // The test suites drive deliberately malformed input through the codecs and
    // assert on the failure, so they hold values the types say cannot exist.
    // Narrowing that to `unknown` and re-casting at every use would obscure what
    // each test is actually checking.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
