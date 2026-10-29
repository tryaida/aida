// `npm pack` / `npm publish` lifecycle (postpack): removes what scripts/prepack.mjs bundled into
// the package (templates/, skills/, LICENSE, NOTICE), so a clone's working tree is left as it was. dist/
// stays: it's the clean build prepack made, and git ignores it.
import { readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export function cleanBundled(dir = engineDir) {
  rmSync(join(dir, "templates"), { recursive: true, force: true });
  rmSync(join(dir, "skills"), { recursive: true, force: true });
  // Only the copies of the repo's LICENSE and NOTICE: never a file someone added to the package itself.
  for (const name of ["LICENSE", "NOTICE"]) {
    const copy = join(dir, name);
    const original = join(dir, "..", "..", name);
    if (existsSync(copy) && existsSync(original) && readFileSync(copy).equals(readFileSync(original))) {
      rmSync(copy, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cleanBundled();
