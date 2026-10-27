// First-publish approval record: `<helpRoot>/.aida/publish.json` (docs/scope.md "Safety and
// trust": "First publish. Always approved by a person."; decisions #10). `aida publish --to
// <host> --prod` without a prior record either prompts interactively (a real TTY) or, in CI/an
// agent, refuses and tells the agent to ask the person — see gates.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aidaDir } from "../edit/help-root.js";

export interface PublishApproval {
  by: string;
  at: string;
  host: string;
}

export function approvalPath(helpRoot: string): string {
  return join(aidaDir(helpRoot), "publish.json");
}

/** The most recent approval, if any production publish has ever been approved for this help app. */
export function readApproval(helpRoot: string): PublishApproval | undefined {
  const file = approvalPath(helpRoot);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PublishApproval;
  } catch {
    return undefined;
  }
}

/** Records a production-publish approval. Called once, by a person (directly or via
 * `--approve --by person`) — see gates.ts for who's allowed to call this. */
export function writeApproval(helpRoot: string, approval: PublishApproval): string {
  const file = approvalPath(helpRoot);
  mkdirSync(join(helpRoot, ".aida"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
  return file;
}
