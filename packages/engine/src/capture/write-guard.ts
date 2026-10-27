const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when `hostname` (as returned by `URL#hostname`) is a local-machine host. */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * True when `baseUrl` points at the local machine (127.0.0.1, localhost, [::1]).
 * Parses the URL and checks the exact hostname — not a prefix/substring match,
 * which a hostile host like `localhost.evil.com` or `127.0.0.1.nip.io` would
 * defeat.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return isLocalHostname(url.hostname);
}

/**
 * Safety gate: write steps (click, type) must not run against a non-local
 * `baseUrl` unless the config explicitly opts in with `allowWrites: true`.
 * Throws rather than silently downgrading to a read-only run.
 */
export function assertWritesAllowed(baseUrl: string, allowWrites: boolean | undefined): void {
  if (isLocalBaseUrl(baseUrl) || allowWrites) return;
  throw new Error(
    `refusing to run write steps against non-local baseUrl ${baseUrl} (set allowWrites: true in aida.config to override)`,
  );
}

/** Query params that can redirect a Postgres-style connection to a different host. */
export const HOST_OVERRIDE_PARAMS = ["host", "hostaddr"];

/**
 * Hard refusal for database checks: the adapter's URL must resolve to
 * 127.0.0.1/localhost/::1 exactly, with no query-param host override (e.g.
 * `?host=prod.example.com`, a libpq/`postgres` npm package feature).
 */
export function assertLocalDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing to run database checks against unparsable database URL ${redact(url)}`);
  }
  if (!isLocalHostname(parsed.hostname)) {
    throw new Error(`refusing to run database checks against non-local database ${redact(url)}`);
  }
  for (const param of HOST_OVERRIDE_PARAMS) {
    if (parsed.searchParams.has(param)) {
      throw new Error(
        `refusing to run database checks against database URL with a "${param}" override ${redact(url)}`,
      );
    }
  }
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return url.replace(/\/\/[^@]*@/, "//");
  }
}
