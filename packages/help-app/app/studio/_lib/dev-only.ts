// Dev-only guard shared by every Studio route handler and the Studio page itself. Studio code
// must never be reachable in a production build/deploy (AGENTS.md: "the Studio is a dev-only
// /studio route"); this is the single enforcement point every file under app/studio/** calls
// first.
import { NextResponse } from "next/server";
import { notFound } from "next/navigation";

export function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

/** For `page.tsx` files: 404s (via Next's not-found UI) outside dev. */
export function assertDevPage(): void {
  if (!isDev()) notFound();
}

/** For `route.ts` handlers: returns a plain 404 response outside dev; callers should `return`
 * this immediately when it's non-null. */
export function devOnlyGuard(): NextResponse | null {
  if (isDev()) return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}
