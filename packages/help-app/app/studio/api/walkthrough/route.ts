import { NextResponse } from "next/server";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertStudioRequest } from "../../_lib/security";
import {
  captureStatus,
  healthFor,
  isSlug,
  loadWalkthroughById,
  readManifest,
  resolveWalkthroughFile,
  siteUrlFor,
  videoFileFor,
} from "../../_lib/server";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !isSlug(id)) return NextResponse.json({ error: "missing or invalid ?id=" }, { status: 400 });

  try {
    const walkthrough = loadWalkthroughById(id);
    const file = resolveWalkthroughFile(id);
    // The latest capture manifest, trimmed to what the screenshot editor needs: per-step
    // resolved boxes (highlights to snap new callouts/blur to, plus the callouts/blur already
    // pinned) and whether a frame image exists at all. `undefined` (not captured yet) is a
    // valid, expected state the client already handles (M22: "no captured screenshot yet").
    const rawManifest = readManifest(id);
    const manifest = rawManifest && {
      viewport: rawManifest.viewport,
      steps: rawManifest.steps.map((s) => ({
        image: s.doc.image,
        highlights: s.doc.highlights,
        callouts: s.doc.callouts ?? [],
        blur: s.doc.blur ?? [],
      })),
    };
    // Top-bar facts: pass/fail + last checked, where the page lives on the help site (hidden
    // when unknown), and whether a rendered video exists for the Page/Video preview toggle.
    return NextResponse.json({
      walkthrough,
      file,
      manifest,
      ...captureStatus(id),
      // Why the last capture failed (who it looks like: walkthrough, app or setup) and the
      // outline card's drift — read by the engine.
      ...healthFor(id),
      siteUrl: siteUrlFor(id),
      hasVideo: Boolean(videoFileFor(id, "mp4")),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}
