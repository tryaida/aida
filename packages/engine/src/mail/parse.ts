// Just enough MIME to show an app's email: headers (with RFC 2047 encoded words), multipart
// bodies, base64 and quoted-printable, UTF-8 or Latin-1. The HTML part is preferred, else text.

export interface CaughtEmail {
  from: string;
  to: string[];
  subject: string;
  date?: string;
  html?: string;
  text?: string;
  /** When the catcher received it (ms since epoch). */
  receivedAt: number;
}

interface Part {
  headers: Record<string, string>;
  body: string;
}

/** Parses one raw message (`raw` is the DATA as received, bytes as Latin-1 characters). */
export function parseMessage(raw: string, envelope: { from?: string; to: string[] } = { to: [] }, now = Date.now()): CaughtEmail {
  const top = splitPart(raw);
  const { html, text } = bodies(top);
  const header = (name: string) => decodeWords(utf8Header(top.headers[name] ?? ""));
  const toHeader = header("to");
  return {
    from: header("from") || (envelope.from ?? ""),
    to: envelope.to.length > 0 ? envelope.to : toHeader.split(",").map((s) => s.trim()).filter(Boolean),
    subject: header("subject"),
    ...(top.headers["date"] ? { date: top.headers["date"] } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(text !== undefined ? { text } : {}),
    receivedAt: now,
  };
}

/** A header sent as raw UTF-8 (SMTPUTF8) arrives as Latin-1 characters: read it back as UTF-8. */
function utf8Header(value: string): string {
  return /[\x80-\xff]/.test(value) ? Buffer.from(value, "latin1").toString("utf8") : value;
}

function splitPart(raw: string): Part {
  const normalized = raw.replace(/\r\n/g, "\n");
  const cut = normalized.indexOf("\n\n");
  const head = cut < 0 ? normalized : normalized.slice(0, cut);
  const body = cut < 0 ? "" : normalized.slice(cut + 2);
  const headers: Record<string, string> = {};
  let last: string | undefined;
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const m = /^([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    last = m[1].toLowerCase();
    headers[last] = headers[last] === undefined ? m[2] : headers[last];
  }
  return { headers, body };
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

function bodies(part: Part): { html?: string; text?: string } {
  const type = (part.headers["content-type"] ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(part.headers["content-type"], "boundary");
    if (!boundary) return {};
    const out: { html?: string; text?: string } = {};
    const chunks = part.body.split(`--${boundary}`).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith("--")) break;
      const found = bodies(splitPart(chunk.replace(/^\n/, "")));
      out.html ??= found.html;
      out.text ??= found.text;
    }
    return out;
  }
  if (/^attachment/i.test(part.headers["content-disposition"] ?? "")) return {};
  const decoded = decodeBody(part.body, part.headers["content-transfer-encoding"], param(part.headers["content-type"], "charset"));
  if (type.startsWith("text/html")) return { html: decoded };
  if (type.startsWith("text/plain")) return { text: decoded };
  return {};
}

function decodeBody(body: string, encoding: string | undefined, charset: string | undefined): string {
  const enc = (encoding ?? "7bit").toLowerCase().trim();
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") bytes = quotedPrintable(body);
  else bytes = Buffer.from(body, "latin1");
  return decodeBytes(bytes, charset);
}

function quotedPrintable(body: string): Buffer {
  const soft = body.replace(/=\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === "=" && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(soft.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** Decodes RFC 2047 encoded words (`=?utf-8?Q?...?=`, `=?utf-8?B?...?=`) in a header. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, data: string) => {
      const bytes = kind.toUpperCase() === "B" ? Buffer.from(data, "base64") : quotedPrintable(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
}
