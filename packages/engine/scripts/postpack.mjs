// `npm pack` / `npm publish` lifecycle (postpack): removes what scripts/prepack.mjs bundled into
// the package (templates/, skills/, LICENSE), so a clone's working tree is left as it was. dist/
// stays: it's the clean build prepack made, and git ignores it.
import { readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export function cleanBundled(dir = engineDir) {
  rmSync(join(dir, "templates"), { recursive: true, force: true });
  rmSync(join(dir, "skills"), { recursive: true, force: true });
  // Only the copy of the repo's LICENSE: never a licence file someone added to the package itself.
  const license = join(dir, "LICENSE");
  const rootLicense = join(dir, "..", "..", "LICENSE");
  if (existsSync(license) && existsSync(rootLicense) && readFileSync(license).equals(readFileSync(rootLicense))) {
    rmSync(license, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cleanBundled();
