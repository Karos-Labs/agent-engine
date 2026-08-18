import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "evals/**/*.test.ts"],
    testTimeout: 30000,
  },
});
