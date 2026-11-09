import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The end-to-end test spawns the server; give it room on a cold start.
    testTimeout: 20_000,
  },
});
