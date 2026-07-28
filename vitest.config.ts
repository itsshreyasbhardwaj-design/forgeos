import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/types.ts',
        // These require a live service to exercise meaningfully. Measuring them
        // against a unit-test threshold would only encourage tests that assert
        // the shape of a request rather than that it works. They need
        // integration tests, which is a roadmap item — not a coverage number.
        '**/ai/openrouter.ts',
        '**/adapters/postgres.ts',
      ],
      // Set just below what the suite actually achieves, so it ratchets against
      // regression rather than describing an aspiration. Raise it as coverage
      // improves; never lower it to make a build pass.
      thresholds: {
        lines: 70,
        functions: 65,
        statements: 70,
        branches: 65,
      },
    },
  },
  resolve: {
    alias: {
      "@forgeos/core": new URL("./packages/core/src/index.ts", import.meta.url)
        .pathname,
      "@forgeos/db": new URL("./packages/db/src/index.ts", import.meta.url)
        .pathname,
      "@forgeos/sdk": new URL("./packages/sdk/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
