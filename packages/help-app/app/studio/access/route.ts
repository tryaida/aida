// /studio/access — where the Studio's private link lands (`/studio/access#key=<key>`). GET serves
// a tiny page that POSTs the key from the URL fragment back here (so the key never appears in a
// URL the dev server logs); POST checks it and sets the access cookie. See _lib/security.ts.
import { devOnlyGuard } from "../_lib/dev-only";
import { studioAccessPage, unlockStudio } from "../_lib/security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  return studioAccessPage(request);
}

export async function POST(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  return unlockStudio(request);
}
