// GET /studio/api/page-asset?id=<walkthrough>&file=step-01.png — one image from a built page's
// own `screenshots/` folder, for the Studio's page preview (the page's relative image links
// can't load from /studio). Read-only, same guards as every Studio route: dev-only, the
// Host/Origin/token check, a validated walkthrough slug, and a bare file name (no path) that
// pageAssetFile only ever resolves inside pages/<id>/screenshots/.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { isSlug, pageAssetFile } from "../../_lib/server";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const name = url.searchParams.get("file");
  if (!id || !isSlug(id) || !name) {
    return NextResponse.json({ error: "missing or invalid ?id=/?file=" }, { status: 400 });
  }

  const asset = pageAssetFile(id, name);
  if (!asset) return NextResponse.json({ error: "no such page image" }, { status: 404 });

  return new NextResponse(readFileSync(asset.file), {
    headers: { "content-type": asset.contentType, "cache-control": "no-store" },
  });
}
