// Generates schema/walkthrough.schema.json from the zod source of truth.
// Run with: npm run schema:gen -w aida
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WalkthroughDocSchema } from "../src/walkthrough/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "schema", "walkthrough.schema.json");

// `io: "input"`: what a person may write (fields with defaults stay optional).
const jsonSchema = z.toJSONSchema(WalkthroughDocSchema, { target: "draft-7", io: "input", unrepresentable: "any" });
writeFileSync(outFile, JSON.stringify({ title: "Walkthrough", ...jsonSchema }, null, 2) + "\n", "utf8");
console.log(`wrote ${outFile}`);
