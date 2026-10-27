// `aida doctor [--config <path>] [--json]` (build-plan.md M24): checks Node, ffmpeg, the
// Playwright browser and its system libraries, disk space, the app's dev-server cache, the
// config, the app's address and database, and the help app's install. Exits 1 when any check
// fails, 0 otherwise (warnings don't fail it). See src/doctor/.
import { formatDoctor, runDoctor } from "../doctor/index.js";
import type { DoctorProbes } from "../doctor/index.js";

export interface RunDoctorCommandOptions {
  configPath?: string;
  /** Injected in tests. */
  probes?: DoctorProbes;
  cwd?: string;
}

export async function runDoctorCommand(opts: RunDoctorCommandOptions, json: boolean): Promise<number> {
  const result = await runDoctor({ configPath: opts.configPath, probes: opts.probes, cwd: opts.cwd });
  console.log(json ? JSON.stringify(result) : formatDoctor(result));
  return result.ok ? 0 : 1;
}
