// POST /studio/api/selection — "point and say" (docs/scope.md "How edits stay safe"): the
// Studio writes the person's current selection here on every click, so an agent asked to act on
// "this" can read what's selected instead of guessing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { aidaDir } from "aida-docs/dist/edit/index.js";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { helpRoot } from "../../_lib/server";

interface SelectionBody {
  walkthroughId?: string;
  stepId?: string;
  field?: string;
}

export function selectionPath(): string {
  return join(aidaDir(helpRoot()), "selection.json");
}

export async function POST(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  let body: SelectionBody;
  try {
    body = (await request.json()) as SelectionBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const selection = { ...body, at: new Date().toISOString() };
  writeFileSync(selectionPath(), `${JSON.stringify(selection, null, 2)}\n`);
  return NextResponse.json({ ok: true, selection });
}
