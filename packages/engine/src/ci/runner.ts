// Injectable command runner for `ci/github.ts`'s git operations — same pattern as
// publish/runner.ts (decisions #23: push to the `aida-previews` orphan branch using the
// workflow's own GITHUB_TOKEN, via plain git in a scratch dir, never the user's checkout).
// Kept local to `ci/` rather than importing publish/runner.ts so the two modules (host deploy vs.
// CI preview push) stay decoupled — same shape, no shared dependency to break either one.
import { execFile, type ExecFileException } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<RunResult>;

export function createNodeCommandRunner(): CommandRunner {
  return (cmd, args, opts) =>
    new Promise((resolvePromise) => {
      execFile(cmd, args, { cwd: opts?.cwd, env: opts?.env as NodeJS.ProcessEnv | undefined, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const exitCode = error ? (typeof (error as ExecFileException).code === "number" ? ((error as ExecFileException).code as number) : 1) : 0;
        resolvePromise({ code: exitCode, stdout, stderr });
      });
    });
}

export function createFakeCommandRunner(
  result: RunResult | ((cmd: string, args: string[]) => RunResult) = { code: 0, stdout: "", stderr: "" },
): { runner: CommandRunner; calls: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }[] } {
  const calls: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }[] = [];
  const runner: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
    return typeof result === "function" ? result(cmd, args) : result;
  };
  return { runner, calls };
}
