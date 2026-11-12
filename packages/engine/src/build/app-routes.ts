// What in-app help needs to know about the app's own addresses (M45, M46): its routes, so a
// captured path such as /polls/abc123 becomes the screen pattern /polls/*, and the path the app is
// served under, so patterns are written relative to it.
import type { ResolvedConfig } from "../config/index.js";
import { buildDigest } from "../digest/index.js";
import { resolveAppDir } from "../safety/database.js";

export interface AppScreens {
  /** The app's page routes in framework form ("/polls/[id]"). Empty when they can't be read. */
  knownRoutes: string[];
  /** The path part of `app.baseUrl` ("/app"), or undefined when the app is served from "/". */
  basePath?: string;
}

/** Never throws: without routes the patterns fall back to id-looking segments and demo values. */
export function appScreens(config: ResolvedConfig): AppScreens {
  let knownRoutes: string[] = [];
  try {
    const appRepo = config.impact?.appRepo ?? resolveAppDir(config)?.dir;
    if (appRepo) {
      const digest = buildDigest(appRepo, { app: config.impact?.app });
      // Several apps and none picked: the routes could belong to any of them.
      if (!digest.apps || digest.apps.length === 0) knownRoutes = digest.routes.map((r) => r.path).sort();
    }
  } catch {
    knownRoutes = [];
  }
  let basePath: string | undefined;
  try {
    const path = new URL(config.app.baseUrl).pathname.replace(/\/+$/, "");
    if (path && path !== "/") basePath = path;
  } catch {
    basePath = undefined;
  }
  return { knownRoutes, basePath };
}
