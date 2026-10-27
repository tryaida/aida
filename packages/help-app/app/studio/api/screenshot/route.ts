// GET /studio/api/screenshot?id=&step=N — serves one step's raw captured frame (unannotated,
// full viewport size) for the Studio's screenshot editor (M22). Raw rather than the published,
// pre-scaled/pre-annotated page screenshot so a click's (x, y) maps directly onto the same
// viewport-px coordinate space `callouts`/`blur` boxes and `boxOf` highlight boxes already use —
// no scale-factor bookkeeping on either side of the wire.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { frameFileFor, isSlug } from "../../_lib/server";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const stepParam = url.searchParams.get("step");
  const step = stepParam ? Number(stepParam) : NaN;
  if (!id || !isSlug(id) || !Number.isInteger(step) || step < 1) {
    return NextResponse.json({ error: "missing or invalid ?id=/?step=" }, { status: 400 });
  }

  const file = frameFileFor(id, step);
  if (!file) return NextResponse.json({ error: "no captured frame for that step" }, { status: 404 });

  const bytes = readFileSync(file);
  return new NextResponse(bytes, {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
