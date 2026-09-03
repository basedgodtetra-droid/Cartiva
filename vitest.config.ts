import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        find: /^react-native$/,
        replacement: fileURLToPath(new URL("./tests/test-doubles/react-native.ts", import.meta.url)),
      },
      {
        find: /^expo-secure-store$/,
        replacement: fileURLToPath(new URL("./tests/test-doubles/expo-secure-store.ts", import.meta.url)),
      },
      {
        find: /^expo-crypto$/,
        replacement: fileURLToPath(new URL("./tests/test-doubles/expo-crypto.ts", import.meta.url)),
      },
      {
        find: /^expo-constants$/,
        replacement: fileURLToPath(new URL("./tests/test-doubles/expo-constants.ts", import.meta.url)),
      },
      {
        find: /^expo-web-browser$/,
        replacement: fileURLToPath(new URL("./tests/test-doubles/expo-web-browser.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "tests/live/**"],
  },
});
