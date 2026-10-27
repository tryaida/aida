import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { isSlug, mtimeOf, readPageText, resolveWalkthroughFile } from "../../_lib/server";
import { stripMarkers } from "aida-docs/dist/pages/markers.js";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !isSlug(id)) return NextResponse.json({ error: "missing or invalid ?id=" }, { status: 400 });

  const { file, text } = readPageText(id);
  if (!file || text === undefined) {
    return NextResponse.json({ found: false });
  }
  // builtAt/editedAt let the preview say "built before your latest edits" (step edits land in
  // the walkthrough file; the page catches up on the next `aida pages`/`aida build`).
  let editedAt: number | undefined;
  try {
    editedAt = mtimeOf(resolveWalkthroughFile(id));
  } catch {
    editedAt = undefined;
  }
  return NextResponse.json({ found: true, file, text, plain: stripMarkers(text), builtAt: mtimeOf(file), editedAt });
}
