import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/product-knowledge-schema.ts",
  out: "./drizzle",
  migrations: { prefix: "timestamp" },
});
