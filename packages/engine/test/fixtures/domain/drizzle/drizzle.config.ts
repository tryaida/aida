// Fixture: a fictional "Acme Events" app's drizzle-kit config (read as text by `aida domain`, never run).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
