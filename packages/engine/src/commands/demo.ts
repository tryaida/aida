// `aida demo [dir] [--no-video] [--full] [--site] [--port <port>] [--keep-running] [--json]`
// (decision 44, build-plan M44): every output from a small fictional sample app, with no setup.
// See src/demo/. Prints progress per stage while it works, then where each output is and what to
// try next. Ctrl-C at any point stops the sample app (and the help site) before exiting; with
// `--keep-running` or `--site` they stay up until Ctrl-C.
import { resolve } from "node:path";
import { formatElapsed, runDemo, shown, stopAll, type DemoResult } from "../demo/index.js";
import type { DoctorProbes } from "../doctor/index.js";

export interface RunDemoCommandOptions {
  /** The demo folder. Default `./aida-demo`. */
  dir?: string;
  /** `--no-video` sets this false: no narration or video, the quickest run. */
  video?: boolean;
  /** Full-quality video instead of the draft render. */
  full?: boolean;
  /** Install the help app and start the help site at the end. */
  site?: boolean;
  /** The sample app's port (default 4310, or a free one when that's taken). */
  port?: string | number;
  /** Leave the sample app running after the build, until Ctrl-C. */
  keepRunning?: boolean;
  /** Injected in tests. */
  probes?: DoctorProbes;
  /** Tests: return instead of waiting for Ctrl-C when something is left running. */
  wait?: boolean;
  cwd?: string;
}

export const DEFAULT_DEMO_DIR = "aida-demo";

/** The `--port` value as a number, or an error message. */
export function parseDemoPort(value: string | number | undefined): { port?: number; error?: string } {
  if (value === undefined) return {};
  const port = typeof value === "number" ? value : /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `--port must be a port number from 0 to 65535 (0 picks a free one), not "${value}"` };
  return { port };
}

function formatSeconds(ms: number): string {
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : formatElapsed(ms);
}

/** The summary printed after a run. */
export function formatDemo(result: DemoResult): string {
  const lines: string[] = [];
  const failedChecks = (result.checks ?? []).filter((c) => c.status === "fail");
  if (failedChecks.length > 0) {
    lines.push("This machine needs a fix before the demo can run:");
    for (const c of failedChecks) {
      lines.push(`  ${c.label}: ${c.detail}`);
      if (c.fix) lines.push(`    fix: ${c.fix}`);
    }
    return lines.join("\n");
  }
  for (const c of result.checks ?? []) if (c.status === "warn") lines.push(`warning: ${c.label}: ${c.detail}${c.fix ? ` (${c.fix})` : ""}`);

  if (result.error && !result.outputs) {
    lines.push(`aida demo stopped after ${formatElapsed(result.totalMs)}: ${result.error}`);
  } else {
    lines.push("");
    lines.push(result.ok ? `Done in ${formatElapsed(result.totalMs)}.` : `Finished in ${formatElapsed(result.totalMs)}, with problems:`);
  }
  for (const f of result.failures ?? []) lines.push(`  ${f}`);
  if (result.error && result.outputs && !result.failures) lines.push(`  ${result.error}`);

  const o = result.outputs;
  if (o) {
    const rows: Array<[string, string | undefined]> = [
      ["Help page", `${shown(o.page)} (screenshots in ${shown(o.screenshots)})`],
      ["PDF guide", o.pdf && shown(o.pdf)],
      ["Quick reference card", o.card && shown(o.card)],
      ["Narrated video", o.video && `${shown(o.video)}${result.draft ? " (draft quality)" : ""}`],
      ["Every guide in one PDF", o.manual && shown(o.manual)],
      ["All of it at a glance", o.proof && shown(o.proof)],
      ["Help site", result.site?.pageUrl],
    ];
    lines.push("");
    lines.push(`What it made for "Mark a repair ready for pickup" (and the other ${Math.max(0, (result.order?.length ?? 1) - 1)} walkthroughs):`);
    const width = Math.max(...rows.filter(([, v]) => v).map(([k]) => k.length));
    for (const [label, value] of rows) if (value) lines.push(`  ${label.padEnd(width)}  ${value}`);
    lines.push(`  ${"Build report".padEnd(width)}  ${shown(o.report)}`);
  }
  if (result.timings.length > 0) {
    lines.push("");
    lines.push(`Time: ${result.timings.map((t) => `${t.stage} ${formatSeconds(t.ms)}`).join(", ")}`);
  }
  if (result.next.length > 0) {
    lines.push("");
    lines.push("Next:");
    result.next.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join("\n");
}

export async function runDemoCommand(opts: RunDemoCommandOptions, json: boolean): Promise<number> {
  const { port, error } = parseDemoPort(opts.port);
  if (error) {
    if (json) console.log(JSON.stringify({ ok: false, error }));
    else console.error(`error: ${error}`);
    return 1;
  }
  const dir = resolve(opts.cwd ?? process.cwd(), opts.dir ?? DEFAULT_DEMO_DIR);
  // Progress goes to stderr under --json, so stdout stays one JSON object.
  const log = (line: string) => (json ? console.error(line) : console.log(line));

  // Ctrl-C or a kill: stop what the demo started, then exit as the signal asks.
  let interrupted: (() => void) | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    log(`\nStopping (${signal})...`);
    void stopAll().finally(() => {
      if (interrupted) interrupted();
      else process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const { result, running } = await runDemo({
      dir,
      video: opts.video,
      full: opts.full,
      site: opts.site,
      port,
      keepRunning: opts.keepRunning,
      log,
      probes: opts.probes,
    });
    if (json) console.log(JSON.stringify(result));
    else console.log(formatDemo(result));

    if (running.length > 0 && opts.wait !== false) {
      const what = [result.app?.running ? `the sample app at ${result.app.url}` : "", result.site ? `the help site at ${result.site.url}` : ""].filter(Boolean).join(" and ");
      log("");
      log(`Leaving ${what} running. Press Ctrl-C to stop.`);
      await new Promise<void>((done) => {
        interrupted = done;
        // Either one stopping on its own (a crash) ends the wait too.
        for (const p of running) void p.exited.then(() => done());
      });
    }
    return result.ok ? 0 : 1;
  } finally {
    await stopAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
