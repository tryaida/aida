// GET /studio/api/history — the Studio's history list (person/agent marks).
// POST /studio/api/history {"undo": true, "by"?: "agent"|"person"} — Undo button.
import { NextResponse } from "next/server";
import { readHistory, undo, type EditBy } from "aida/dist/edit/index.js";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { helpRoot } from "../../_lib/server";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const entries = readHistory(helpRoot()).slice().reverse(); // newest first, for the Studio list
  return NextResponse.json({ entries });
}

export async function POST(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  let body: { by?: EditBy } = {};
  try {
    body = (await request.json()) as { by?: EditBy };
  } catch {
    // No body ("undo the last edit, whoever made it") is fine.
  }

  try {
    const result = undo(helpRoot(), body.by);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
