import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Cleans up the temp folders tests leave behind (test/global-teardown.ts).
    globalSetup: ["./test/global-teardown.ts"],
  },
});
