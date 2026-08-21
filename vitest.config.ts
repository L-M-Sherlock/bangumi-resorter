import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // Forecast simulations use the production 3×-item horizon; allow the
    // deterministic worker tests to complete without changing their logic.
    testTimeout: 15_000,
  },
});
