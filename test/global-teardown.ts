// Removes the `aida-*` temp folders tests made during this run. Many tests make one with
// mkdtemp and leave it; on a machine whose /tmp is a small tmpfs, a few hundred runs fill it.
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const started = Date.now();
  return () => {
    const dir = tmpdir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("aida-")) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).ctimeMs >= started) rmSync(full, { recursive: true, force: true });
      } catch {
        // gone already, or not ours to remove
      }
    }
  };
}
