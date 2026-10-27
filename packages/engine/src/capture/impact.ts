import type { Page, Request } from "playwright";
import type { ImpactRequest, StepImpact } from "./types.js";

/**
 * Tracks same-origin navigations and API requests while a step runs, for the
 * `impact` field aida adds to the manifest (seed for the CI impact map).
 */
export class ImpactTracker {
  private urls = new Set<string>();
  private requests: ImpactRequest[] = [];
  private origin: string;

  constructor(private page: Page, baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
    page.on("request", this.onRequest);
    page.on("framenavigated", this.onNavigated);
  }

  private onRequest = (req: Request): void => {
    try {
      const u = new URL(req.url());
      if (u.origin !== this.origin) return;
      // A Next.js server action posts to the page's own URL, so the path alone can't tell two
      // actions apart (or one action called from two pages): its id is in the Next-Action header.
      const action = req.method() === "GET" ? undefined : req.headers()["next-action"];
      this.requests.push({ method: req.method(), path: u.pathname + (u.search || ""), ...(action ? { action } : {}) });
    } catch {
      // ignore unparsable URLs
    }
  };

  private onNavigated = (): void => {
    try {
      const u = new URL(this.page.url());
      if (u.origin === this.origin) this.urls.add(u.pathname + (u.search || ""));
    } catch {
      // page may be mid-navigation; ignore
    }
  };

  /** Returns everything collected since the last call, then clears the buffer. */
  take(): StepImpact {
    const impact: StepImpact = { urls: [...this.urls], requests: [...this.requests] };
    this.urls.clear();
    this.requests = [];
    return impact;
  }

  dispose(): void {
    this.page.off("request", this.onRequest);
    this.page.off("framenavigated", this.onNavigated);
  }
}
