// GET /studio/api/video?id=<walkthrough>&kind=mp4|vtt — the walkthrough's rendered video (or its
// captions) for the preview's Video tab. Same guards as every Studio route: dev-only, the
// Host/Origin/token check and a validated slug; the file is always `<id>.<kind>` inside the
// walkthrough's own videos folder (videoFileFor), never a path from the request.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import { isSlug, videoFileFor, type VideoKind } from "../../_lib/server";

const CONTENT_TYPES: Record<VideoKind, string> = { mp4: "video/mp4", vtt: "text/vtt; charset=utf-8" };

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind") ?? "mp4";
  if (!id || !isSlug(id) || (kind !== "mp4" && kind !== "vtt")) {
    return NextResponse.json({ error: "missing or invalid ?id=/?kind=" }, { status: 400 });
  }

  const file = videoFileFor(id, kind);
  if (!file) return NextResponse.json({ error: "no rendered video for that walkthrough" }, { status: 404 });

  return new NextResponse(readFileSync(file), {
    headers: { "content-type": CONTENT_TYPES[kind], "cache-control": "no-store" },
  });
}
