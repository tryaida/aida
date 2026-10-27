// Generates schema/walkthrough.schema.json from the zod source of truth.
// Run with: npm run schema:gen -w aida
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WalkthroughDocSchema } from "../src/walkthrough/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "schema", "walkthrough.schema.json");

const jsonSchema = zodToJsonSchema(WalkthroughDocSchema, "Walkthrough");
writeFileSync(outFile, JSON.stringify(jsonSchema, null, 2) + "\n", "utf8");
console.log(`wrote ${outFile}`);
