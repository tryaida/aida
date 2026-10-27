// The real `CommandRunner` (publish/types.ts) — the only place `aida publish` shells out for
// real. Every adapter takes a runner as a parameter instead of importing this directly, so tests
// always inject a fake and never hit the network or need a host CLI installed.
import { spawn } from "node:child_process";
import type { CommandRunner } from "./types.js";

export function createNodeCommandRunner(): CommandRunner {
  return (cmd, args, opts) =>
    new Promise((resolvePromise) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        resolvePromise({ code: 1, stdout, stderr: stderr + String(err) });
      });
      child.on("close", (code) => {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
}

/** A runner that records every call and returns a fixed result — the default test double. */
export function createFakeCommandRunner(
  result: RunResult | ((cmd: string, args: string[]) => RunResult) = { code: 0, stdout: "", stderr: "" },
): { runner: CommandRunner; calls: { cmd: string; args: string[]; cwd?: string }[] } {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const runner: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return typeof result === "function" ? result(cmd, args) : result;
  };
  return { runner, calls };
}

type RunResult = import("./types.js").RunResult;
