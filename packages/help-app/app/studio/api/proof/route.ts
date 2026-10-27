// GET /studio/api/proof?kind=json|png — the latest proof sheet `aida proof` wrote (decision 35:
// approve the look once at checkpoint 1). Same guards as every Studio route: dev-only and the
// Host/Origin/token check; the file is always `<buildDir>/proof/proof.<kind>` (proofFileFor).
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { proofFileFor } from "../../_lib/server";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const kind = new URL(request.url).searchParams.get("kind") ?? "json";
  if (kind !== "json" && kind !== "png") return NextResponse.json({ error: "invalid ?kind=" }, { status: 400 });

  const file = proofFileFor(kind);
  if (!file) return NextResponse.json({ error: "no proof sheet yet" }, { status: 404 });
  const body = readFileSync(file);
  return new NextResponse(body, {
    headers: { "content-type": kind === "png" ? "image/png" : "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
