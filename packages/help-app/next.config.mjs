import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Installed on its own (`aida init` runs npm install here), this app has its own lockfile inside
// the app it documents, which has one too; Next would then pick the outer app as the workspace
// root and trace that whole app into the build. Pin the root to this folder in that case. Inside
// the aida monorepo `next` is hoisted to the repo root, so leave Next's own inference alone.
const here = dirname(fileURLToPath(import.meta.url));
const standalone = existsSync(join(here, "node_modules", "next", "package.json"));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // aida writes its own Markdown output to a `pages/` folder next to this app. Only .tsx/.ts
  // files are routes, so that folder is never mistaken for Pages Router pages.
  pageExtensions: ["tsx", "ts"],
  // Next.js writes an AGENTS.md into the app on `next dev` unless told not to; this app is
  // generated and owned by aida, so keep the user's repo free of it.
  agentRules: false,
  ...(standalone ? { turbopack: { root: here }, outputFileTracingRoot: here } : {}),
  // Lets the dev-only Studio load through a dev tunnel or proxy listed in
  // AIDA_STUDIO_ALLOWED_HOSTS (exact hostnames, comma-separated; `aida init --tunnel-host`
  // writes it to .env.local, which Next loads before this file). The Studio's own Host/Origin
  // checks (app/studio/_lib/security.ts) read the same variable. Off localhost the Studio also
  // needs its access key (AIDA_STUDIO_KEY, written by the same command).
  allowedDevOrigins: (process.env.AIDA_STUDIO_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  // The in-app widget (public/widget.js) and the tour script (public/tour.js) run on the
  // documented app's origin and read these from the help site. They are already-public,
  // read-only published docs data (brand/theme.json holds only the brand's name, colours, font
  // and logo path), so any origin may read them; nothing else on the site gets the header (chat
  // keeps its own allow-list).
  // A static export can't send headers (Next warns if asked to); the static host sets them.
  ...(process.env.AIDA_STATIC_EXPORT === "1"
    ? {}
    : {
        async headers() {
          const anyOrigin = [{ key: "Access-Control-Allow-Origin", value: "*" }];
          return ["/help-map.json", "/search-index.json", "/brand/theme.json", "/tours/:path*"].map((source) => ({ source, headers: anyOrigin }));
        },
      }),
};

export default withMDX(config);
