import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{
      find: "@",
      replacement: fileURLToPath(new URL(".", import.meta.url)),
    }],
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
  },
});
