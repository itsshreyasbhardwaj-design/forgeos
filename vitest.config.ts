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
      exclude: ["**/*.test.ts", "**/index.ts", "**/types.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
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
