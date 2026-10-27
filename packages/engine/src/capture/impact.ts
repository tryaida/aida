import type { Page, Request, Response } from "playwright";
import type { ImpactRequest, StepImpact } from "./types.js";

/**
 * True when a Next.js server action's response headers say it changed something: it revalidated
 * a path or tag, changed a cookie itself, or redirected (decision 37). Next 16 sends
 * `x-action-revalidated: 1|2` (absent or `0` when nothing was revalidated; an action that sets a
 * cookie gets `2`); Next 14/15 send `[[paths…], tagRevalidated, cookieRevalidated]`, where
 * `[[],0,0]` means nothing. A bare `Set-Cookie` is not a save: auth middleware (Auth.js, Supabase)
 * refreshes the session cookie on every response, reads included. A header we can't read counts
 * as a save, never as a read.
 */
export function serverActionSaved(headers: Record<string, string>): boolean {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (h["x-action-redirect"]) return true;
  const revalidated = h["x-action-revalidated"];
  if (revalidated === undefined || revalidated.trim() === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(revalidated);
  } catch {
    return true;
  }
  if (typeof parsed === "number") return parsed !== 0;
  if (Array.isArray(parsed)) {
    const [paths, tags, cookies] = parsed as unknown[];
    return (Array.isArray(paths) && paths.length > 0) || Boolean(tags) || Boolean(cookies);
  }
  return Boolean(parsed);
}

export type GraphqlKind = "query" | "mutation" | "subscription";
export interface GraphqlOperation {
  kind: GraphqlKind;
  /** The operation's name, or for an anonymous one its first root field (`createPayment`). */
  name?: string;
  /** True when `name` is the first root field of an anonymous operation. */
  anonymous?: boolean;
}

/** True for a request to a GraphQL endpoint: a path ending in `/graphql`, or an
 * `application/graphql` body. Only these are read as GraphQL: a plain API route whose JSON body
 * has a `query` field is a save like any other POST. */
export function isGraphqlRequest(pathname: string, contentType: string | undefined): boolean {
  return /(^|\/)graphql\/?$/i.test(pathname) || /^application\/graphql\b/i.test(contentType ?? "");
}

/** What a GraphQL request body asks for: `query` (a read), `mutation` (a save, with its operation
 * name or, anonymous, its first root field) or undefined when the body isn't a GraphQL operation
 * document we can read (a persisted query, a malformed document). A batch is a mutation when any
 * of its operations is. Call it only for a GraphQL endpoint (`isGraphqlRequest`). */
export function graphqlOperation(body: string | null | undefined): GraphqlOperation | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // `application/graphql`: the body is the document itself.
    return pickOperation(parseOperations(body), undefined);
  }
  const ops = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => graphqlOne(p));
  if (ops.length === 0 || ops.some((o) => o === undefined)) return undefined;
  const mutation = ops.find((o) => o!.kind === "mutation");
  return mutation ?? ops[0];
}

function graphqlOne(payload: unknown): GraphqlOperation | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { query, operationName } = payload as { query?: unknown; operationName?: unknown };
  if (typeof query !== "string") return undefined;
  return pickOperation(parseOperations(query), typeof operationName === "string" ? operationName : undefined);
}

function pickOperation(ops: ParsedOperation[] | undefined, operationName: string | undefined): GraphqlOperation | undefined {
  if (!ops || ops.length === 0) return undefined;
  const op = (operationName ? ops.find((o) => o.name === operationName) : undefined) ?? ops.find((o) => o.kind === "mutation") ?? ops[0]!;
  if (op.name) return { kind: op.kind, name: op.name };
  if (op.rootField) return { kind: op.kind, name: op.rootField, anonymous: true };
  return { kind: op.kind };
}

interface ParsedOperation {
  kind: GraphqlKind;
  name?: string;
  rootField?: string;
}

/** Index just past the `}` closing the `{` at `open`, skipping strings; -1 when unbalanced. */
function closeBrace(doc: string, open: number): number {
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    const c = doc[i];
    if (c === '"') {
      for (i++; i < doc.length && doc[i] !== '"'; i++) if (doc[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The operation definitions of a GraphQL document, top level only (fragments skipped), or
 * undefined when it isn't one: every top-level item must be `{ … }` or a keyword definition. */
function parseOperations(source: string): ParsedOperation[] | undefined {
  const doc = source.replace(/#[^\n]*/g, " ");
  const ops: ParsedOperation[] = [];
  let i = 0;
  for (;;) {
    while (i < doc.length && /[\s,]/.test(doc[i]!)) i++;
    if (i >= doc.length) break;
    let kind: GraphqlKind | "fragment" = "query";
    let name: string | undefined;
    let open = i;
    if (doc[i] !== "{") {
      const m = /^(query|mutation|subscription|fragment)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(doc.slice(i));
      if (!m) return undefined;
      kind = m[1] as GraphqlKind | "fragment";
      name = m[2];
      // Variables `( … )`, a fragment's `on Type`, directives: up to the selection set's `{`.
      let j = i + m[0].length;
      let parens = 0;
      for (; j < doc.length; j++) {
        if (doc[j] === "(") parens++;
        else if (doc[j] === ")") parens--;
        else if (doc[j] === "{" && parens === 0) break;
      }
      if (j >= doc.length) return undefined;
      open = j;
    }
    const end = closeBrace(doc, open);
    if (end === -1) return undefined;
    if (kind !== "fragment") {
      const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(doc.slice(open + 1, end - 1));
      ops.push({ kind, ...(name ? { name } : {}), ...(field ? { rootField: field[2] ?? field[1] } : {}) });
    }
    i = end;
  }
  return ops.length > 0 ? ops : undefined;
}

/**
 * Tracks same-origin navigations and API requests while a step runs, for the
 * `impact` field aida adds to the manifest (seed for the CI impact map), and tells reads from
 * saves where the request alone can't (decision 37): a server action is a POST whether it saves or
 * reads, so its response headers decide; a POST to a GraphQL endpoint is a read when it's a query.
 */
export class ImpactTracker {
  private urls = new Set<string>();
  private requests: ImpactRequest[] = [];
  private origin: string;
  private actions = new WeakMap<Request, ImpactRequest>();
  /** Server actions sent and not yet answered. */
  private awaiting = new Set<Request>();
  /** Header reads in flight. */
  private reading = new Set<Promise<void>>();

  constructor(private page: Page, baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    page.on("framenavigated", this.onNavigated);
  }

  private onRequest = (req: Request): void => {
    try {
      const u = new URL(req.url());
      if (u.origin !== this.origin) return;
      const method = req.method();
      // A Next.js server action posts to the page's own URL, so the path alone can't tell two
      // actions apart (or one action called from two pages): its id is in the Next-Action header.
      const action = method === "GET" ? undefined : req.headers()["next-action"];
      const entry: ImpactRequest = { method, path: u.pathname + (u.search || ""), ...(action ? { action } : {}) };
      if (action) {
        this.actions.set(req, entry);
        this.awaiting.add(req);
      } else if (method !== "GET" && method !== "HEAD" && isGraphqlRequest(u.pathname, req.headers()["content-type"])) {
        const gql = graphqlOperation(safePostData(req));
        if (gql && gql.kind !== "mutation") entry.read = true;
        else if (gql?.name) entry.operation = gql.anonymous ? `mutation { ${gql.name} }` : `mutation ${gql.name}`;
      }
      this.requests.push(entry);
    } catch {
      // ignore unparsable URLs
    }
  };

  private onResponse = (res: Response): void => {
    const req = res.request();
    const entry = this.actions.get(req);
    if (!entry) return;
    // The entry is the same object the step's impact (and so the manifest) holds.
    const reading = res
      .allHeaders()
      .then((headers) => {
        if (!serverActionSaved(headers)) entry.read = true;
      })
      .catch(() => {})
      .finally(() => {
        this.awaiting.delete(req);
        this.reading.delete(reading);
      });
    this.reading.add(reading);
  };

  private onRequestFailed = (req: Request): void => {
    // No answer: it stays a save (never assumed a read).
    this.awaiting.delete(req);
  };

  /**
   * Waits (at most `capMs`) until every server action seen has answered and its headers were
   * read, so no read flag lands after the manifest is written. Call before `dispose()`. An action
   * still unanswered at the cap stays counted as a save.
   */
  async settled(capMs = 5_000): Promise<void> {
    const deadline = Date.now() + capMs;
    while ((this.awaiting.size > 0 || this.reading.size > 0) && Date.now() < deadline) {
      // A real timer each round: an empty `reading` would otherwise spin on microtasks and starve
      // the very response events being waited for.
      await new Promise((r) => setTimeout(r, 25));
    }
  }

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
    this.page.off("response", this.onResponse);
    this.page.off("framenavigated", this.onNavigated);
  }
}

function safePostData(req: Request): string | null {
  try {
    return req.postData();
  } catch {
    return null;
  }
}
