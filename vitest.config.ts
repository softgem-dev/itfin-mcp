import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests share one Keychain test entry, so run files serially.
    fileParallelism: false,
  },
});
