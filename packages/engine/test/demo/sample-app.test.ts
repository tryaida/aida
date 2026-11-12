// The demo's sample app (assets/demo-app/app): loopback only, the same seed every start, a local
// reset, validation, the status flow, form posts from its own pages only, and every action of its
// walkthroughs (read from their YAML files) run in a real browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DEMO_APP_DIR, DEMO_WALKTHROUGHS_DIR } from "../../src/demo/index.js";
import { locate } from "../../src/capture/locate.js";
import { loadWalkthroughFile } from "../../src/walkthrough/index.js";
import { resolveTemplatesDeep } from "../../src/walkthrough/template.js";
import { planRunFromFiles } from "../../src/states/index.js";
import type { Action, Target } from "../../src/walkthrough/types.js";

type App = { url: string; port: number; close: () => Promise<void>; server: import("node:http").Server };
const server = (await import(join(DEMO_APP_DIR, "server.mjs"))) as {
  startServer: (o?: { port?: number; host?: string }) => Promise<App>;
  isLoopbackAddress: (a: string | undefined) => boolean;
};
const store = (await import(join(DEMO_APP_DIR, "lib", "store.mjs"))) as { seedData: () => unknown; createStore: () => { listJobs: () => unknown[] } };

/** A form post as the app's own pages send it: the browser adds the page's Origin. */
async function post(url: string, form: Record<string, string>, headers: Record<string, string> = { origin: new URL(url).origin }): Promise<Response> {
  return fetch(url, { method: "POST", body: new URLSearchParams(form), redirect: "manual", headers });
}

describe("sample app server", { timeout: 20_000 }, () => {
  let app: App;
  beforeAll(async () => {
    app = await server.startServer({ port: 0 });
  });
  afterAll(async () => {
    await app.close();
  });

  it("listens on 127.0.0.1 only, and refuses any other host", async () => {
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((app.server.address() as { address: string }).address).toBe("127.0.0.1");
    await expect(server.startServer({ port: 0, host: "0.0.0.0" })).rejects.toThrow(/only listens on this machine/);
    expect(server.isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(server.isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(server.isLoopbackAddress("::1")).toBe(true);
    expect(server.isLoopbackAddress("192.168.1.4")).toBe(false);
  });

  it("refuses a request for another host name (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: app.port, path: "/jobs", headers: { host: "attacker.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("starts from the same seed every time", () => {
    expect(store.seedData()).toEqual(store.seedData());
    expect(store.createStore().listJobs()).toEqual(store.createStore().listJobs());
    expect(store.createStore().listJobs()).toHaveLength(8);
  });

  it("serves every screen with its landmarks, labels and headings", async () => {
    const jobs = await (await fetch(`${app.url}/jobs`)).text();
    expect(jobs).toContain('<nav aria-label="Main">');
    expect(jobs).toContain('<nav class="filters" aria-label="Filter by status">');
    expect(jobs).toContain('<label for="q">Search jobs</label>');
    expect(jobs).toContain("<h1>Repair jobs</h1>");
    expect(jobs).toContain('<main id="main"');
    expect(jobs).toContain('href="/jobs/new">New job</a>');
    const form = await (await fetch(`${app.url}/jobs/new`)).text();
    for (const label of ["Customer name", "Phone", "Email (optional)", "Item", "Type", "What&#39;s wrong"]) expect(form).toContain(`>${label}</label>`);
    const job = await (await fetch(`${app.url}/jobs/J-1041`)).text();
    expect(job).toContain('aria-labelledby="status-heading"');
    expect(job).toContain('<dialog id="ready-dialog" aria-labelledby="ready-title">');
    const settings = await (await fetch(`${app.url}/settings`)).text();
    expect(settings).toContain(">Opening hours</label>");
    expect(settings).toContain(">Standard turnaround</label>");
    expect((await fetch(`${app.url}/nowhere`)).status).toBe(404);
    expect((await fetch(`${app.url}/styles.css`)).headers.get("content-type")).toMatch(/text\/css/);
  });

  it("validates a new job, keeps what was typed, and escapes it", async () => {
    const bad = await post(`${app.url}/jobs`, { name: "<b>Sam</b>", phone: "12", email: "not-an-email" });
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter a phone number with at least 7 digits");
    expect(html).toContain("Enter an email address like name@example.com");
    expect(html).toContain("Choose the type of item");
    expect(html).toContain('value="&lt;b&gt;Sam&lt;/b&gt;"');
    expect(html).not.toContain("<b>Sam</b>");
    expect(html).toContain('aria-invalid="true"');
  });

  it("takes in a job, moves it through its statuses, and the reset puts the seed back", async () => {
    const created = await post(`${app.url}/jobs`, {
      name: "Dana Whitfield",
      phone: "(415) 555-0193",
      email: "dana.whitfield@example.com",
      item: "Mountain bike",
      type: "Bike",
      problem: "Front brake squeals.",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/jobs/J-1043?done=created");
    expect(await (await fetch(`${app.url}/jobs/J-1043?done=created`)).text()).toContain("Job J-1043 saved");

    // Out of order: a waiting job can't be marked ready.
    await post(`${app.url}/jobs/J-1043/status`, { status: "ready" });
    expect(await (await fetch(`${app.url}/jobs/J-1043`)).text()).toContain("badge-waiting");
    expect((await post(`${app.url}/jobs/J-1043/status`, { status: "in-progress" })).headers.get("location")).toBe("/jobs/J-1043?done=in-progress");
    expect((await post(`${app.url}/jobs/J-1043/status`, { status: "ready", note: "New pads fitted." })).headers.get("location")).toBe("/jobs/J-1043?done=ready");
    const ready = await (await fetch(`${app.url}/jobs/J-1043`)).text();
    expect(ready).toContain("badge-ready");
    expect(ready).toContain("Ready for pickup: New pads fitted.");

    expect((await post(`${app.url}/settings`, { shopName: "", turnaroundDays: "5" })).status).toBe(422);
    expect((await post(`${app.url}/settings`, { shopName: "Acme Repairs", hours: "Mon to Sat", turnaroundDays: "7" })).status).toBe(303);
    expect(await (await fetch(`${app.url}/jobs/new`)).text()).toContain("Standard turnaround is 7 working days.");

    const reset = await post(`${app.url}/settings/sample-data`, {});
    expect(reset.headers.get("location")).toBe("/settings?done=sample-data");
    expect((await fetch(`${app.url}/jobs/J-1043`)).status).toBe(404);
    expect(await (await fetch(`${app.url}/jobs/new`)).text()).toContain("Standard turnaround is 5 working days.");
    // The next job gets the same number again.
    const again = await post(`${app.url}/jobs`, { name: "A", phone: "(415) 555-0100", item: "Lamp", type: "Other", problem: "Dead." });
    expect(again.headers.get("location")).toBe("/jobs/J-1043?done=created");
    await post(`${app.url}/settings/sample-data`, {});
  });

  it("answers an oversized form with 413 and closes the connection, saving nothing", async () => {
    for (const kb of [70, 400]) {
      const res = await post(`${app.url}/jobs`, { name: "Big", phone: "(415) 555-0100", item: "Lamp", type: "Other", problem: "x".repeat(kb * 1024) });
      expect(res.status, `${kb} KB`).toBe(413);
      expect(res.headers.get("connection")).toBe("close");
      expect(await res.text()).toMatch(/too large/);
    }
    expect((await fetch(`${app.url}/jobs/J-1043`)).status).toBe(404);
  });

  it("refuses a form post from another site, or with no Origin or Referer, and changes nothing", async () => {
    const form = { name: "Mallory", phone: "(415) 555-0199", item: "Phone", type: "Other", problem: "Sent from elsewhere." };
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { referer: "https://evil.example/page" }, {}]) {
      const res = await post(`${app.url}/jobs`, form, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    const reset = await post(`${app.url}/settings/sample-data`, {}, { origin: "https://evil.example" });
    expect(reset.status).toBe(403);
    expect((await fetch(`${app.url}/jobs/J-1043`)).status).toBe(404);
    // From its own page, by Origin or (without one) by Referer.
    const own = await post(`${app.url}/jobs`, form, { referer: `${app.url}/jobs/new` });
    expect(own.status).toBe(303);
    await post(`${app.url}/settings/sample-data`, {});
  });
});

/** Every walkthrough's actions, setup first, `{{data}}` filled in, in the order `aida build`
 * captures them (needs/leaves). */
function walkthroughsInOrder(): Array<{ id: string; start: string; actions: Action[] }> {
  const files = readdirSync(DEMO_WALKTHROUGHS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(DEMO_WALKTHROUGHS_DIR, f));
  const plan = planRunFromFiles({ walkthroughsDir: DEMO_WALKTHROUGHS_DIR }, files, { reset: "database-checks" }).plan;
  return plan.walkthroughs.map((p) => {
    const wf = p.walkthrough;
    const steps = [...(wf.setup?.steps ?? []), ...wf.steps];
    return { id: wf.walkthrough, start: wf.start.page, actions: resolveTemplatesDeep(steps.flatMap((s) => s.actions ?? []), wf.data ?? {}) as Action[] };
  });
}

describe("sample app in a browser: every walkthrough's actions, from its YAML file", () => {
  it("finds every target and reaches every expected page and message", async () => {
    const { chromium } = await import("playwright");
    const app = await server.startServer({ port: 0 });
    const browser = await chromium.launch();
    const done: string[] = [];
    let targets = 0;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(10_000);
      const found = async (target: Target, where: string) => {
        const loc = await locate(target, page);
        await loc.waitFor({ state: "visible" }).catch(() => {
          throw new Error(`${where}: no visible element for ${JSON.stringify(target)}`);
        });
        targets++;
        return loc;
      };
      for (const wt of walkthroughsInOrder()) {
        await page.goto(`${app.url}${wt.start}`);
        for (const [i, a] of wt.actions.entries()) {
          const where = `${wt.id} action ${i + 1} (${a.do})`;
          const act = a as Action & { target?: Target; text?: string; option?: string; path?: string; pattern?: string };
          if (act.do === "goto") await page.goto(`${app.url}${act.path}`);
          else if (act.do === "click") await (await found(act.target!, where)).click();
          else if (act.do === "type") await (await found(act.target!, where)).fill(act.text!);
          else if (act.do === "select") await (await found(act.target!, where)).selectOption({ label: act.option! });
          else if (act.do === "point") await found(act.target!, where);
          else if (act.do === "waitForUrl") await page.waitForURL(new RegExp(act.pattern!));
          else if (act.do === "expect") expect(await (await found(act.target!, where)).textContent(), where).toContain(act.text ?? "");
          else throw new Error(`${where}: this test doesn't run "${act.do}" yet`);
        }
        done.push(wt.id);
      }
      expect(done).toHaveLength(readdirSync(DEMO_WALKTHROUGHS_DIR).filter((f) => f.endsWith(".yaml")).length);
      expect(targets).toBeGreaterThan(20);

      // A filter link is named by its label alone, its count a description: the walkthroughs and
      // the pages' alt text say "Waiting", not "Waiting 3".
      await page.goto(`${app.url}/jobs`);
      const waiting = page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: "Waiting", exact: true });
      await expect(waiting.count()).resolves.toBe(1);
      await expect(waiting.getAttribute("aria-describedby")).resolves.toBe("count-waiting");
    } finally {
      await browser.close();
      await app.close();
    }
  }, 90_000);
});
