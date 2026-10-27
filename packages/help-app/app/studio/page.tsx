// The Studio (M9): a dev-only `/studio` route that edits the help app's own repo files directly
// (Keystatic/TinaCMS style) — see docs/scope.md "The Studio" and decisions #9/#19. Phase 1 scope:
// edit walkthrough step fields (say/caption/page_text/title/hold), callouts and blur boxes
// (M22), with a preview of the built page/video and the edit history.
//
// Dev-only by contract (AGENTS.md: "the Studio is a dev-only /studio route") — this guard is the
// enforcement point: anything under app/studio/** must stay unreachable in a production build, so
// a host that accidentally serves it never exposes an editor. Every route handler under
// app/studio/api/** has the matching guard (`_lib/dev-only.ts`).
//
// Opened through a tunnel or proxy whose host isn't allowed, Next blocks the Studio's dev scripts
// (`allowedDevOrigins`) and its API refuses the host (`_lib/security.ts`), so the page would load
// forever. Instead it says so, server-rendered, with the exact line to add (M25).
//
// With an access key set (always, once a tunnel host is set up) the Studio needs its access cookie,
// on localhost too (security.ts `studioAccess`); with no key it only opens on localhost. Without
// access the page redirects to /studio/access, where the private link `/studio/access#key=<key>`
// sets the cookie or a plain 403 says to open that link, before anything below (token, hosts) is
// rendered.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { StudioApp } from "@/components/studio/StudioApp";
import { assertDevPage } from "./_lib/dev-only";
import { allowHostLine, blockedStudioHost, getStudioToken, STUDIO_ACCESS_PATH, studioAccess } from "./_lib/security";
import "./studio.css";

export const metadata = { title: "Studio" };

// Fills in the address bar's host for the stalled-load notice below. Plain inline script: it has
// to run even when Next's own scripts are blocked.
const FILL_HOST = `document.querySelectorAll("[data-studio-host]").forEach(function(e){e.textContent=location.hostname})`;

export default async function StudioPage() {
  assertDevPage();
  const requestHeaders = await headers();
  // /studio/access sets the cookie from the private link's #key=, or answers 403.
  if (!studioAccess(requestHeaders).ok) redirect(STUDIO_ACCESS_PATH);
  const blocked = blockedStudioHost(requestHeaders);
  if (blocked) {
    return (
      <main className="studio-root studio-host-blocked">
        <h1>The Studio isn't available at {blocked}</h1>
        <p>
          The Studio edits this help app&apos;s files, so it only loads on localhost and on hosts you list. To open it
          at <strong>{blocked}</strong>, add this line to the help app&apos;s <code>.env.local</code> (if a{" "}
          <code>AIDA_STUDIO_ALLOWED_HOSTS</code> line is already there, add <code>,{blocked}</code> to its end instead):
        </p>
        <pre>{allowHostLine(blocked)}</pre>
        <p>Then restart the dev server.</p>
        <p>
          Or run <code>aida init --tunnel-host {blocked}</code>, which also prints the Studio&apos;s private access
          link. Anyone with that link can edit these files, including code the dev server runs, so keep it private.
        </p>
      </main>
    );
  }
  // The token is embedded here, in a same-origin server-rendered response — a cross-site request
  // has no way to read it. StudioApp sends it back on every /studio/api/** call (security.ts).
  return (
    <>
      <StudioApp studioToken={getStudioToken()} />
      {/* Shown by CSS after ~8 s unless StudioApp has mounted (it sets data-studio-ready on
       * <html>), so a blocked load says why even when no script of ours ever runs. */}
      <div className="studio-root studio-stalled" role="status">
        <strong>The Studio hasn&apos;t started.</strong> If you opened it through a tunnel or proxy, Next is probably
        blocking its scripts: add <span data-studio-host suppressHydrationWarning>this host</span> to{" "}
        <code>AIDA_STUDIO_ALLOWED_HOSTS</code> in the help app&apos;s <code>.env.local</code> (comma-separated), then
        restart the dev server.
      </div>
      <script dangerouslySetInnerHTML={{ __html: FILL_HOST }} />
    </>
  );
}
