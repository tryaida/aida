// The local mail catcher (config `mail`): speaks enough SMTP for an app's mailer, parses what it
// catches, never relays anything.
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMailCatcher, type MailCatcher } from "../../src/mail/catcher.js";
import { decodeWords, parseMessage } from "../../src/mail/parse.js";

let catcher: MailCatcher | undefined;
afterEach(async () => {
  await catcher?.close();
  catcher = undefined;
});

/** A minimal SMTP client: sends `lines` one at a time, each after the server's reply. */
async function send(port: number, lines: string[]): Promise<string[]> {
  const replies: string[] = [];
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let i = 0;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buffer += d;
      // A reply is complete when its last line has a space after the code ("250 OK", not "250-").
      if (!/(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(buffer)) return;
      replies.push(buffer);
      buffer = "";
      if (i < lines.length) socket.write(`${lines[i++]}\r\n`);
      else socket.end();
    });
    socket.on("end", () => resolve(replies));
    socket.on("error", reject);
  });
}

const MESSAGE = [
  "From: Acme <no-reply@example.com>",
  "To: sam@example.com",
  "Subject: =?utf-8?Q?Your_booking_=E2=9C=93?=",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello Sam",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>Hello <b>Sam</b> =E2=80=94 see you soon</p>",
  "..dot-stuffed line",
  "--b1--",
].join("\r\n");

describe("mail catcher", () => {
  it("catches a message over SMTP, with login, and parses it", async () => {
    catcher = await startMailCatcher(0);
    const replies = await send(catcher.port, [
      "EHLO app",
      "AUTH PLAIN AGFiYwBkZWY=",
      "MAIL FROM:<no-reply@example.com>",
      "RCPT TO:<sam@example.com>",
      "DATA",
      `${MESSAGE}\r\n.`,
      "QUIT",
    ]);
    expect(replies[0]).toMatch(/^220/);
    expect(replies.at(-1)).toMatch(/^221/);
    const m = await catcher.waitFor((e) => e.subject.includes("booking"), 1000);
    expect(m.subject).toBe("Your booking ✓");
    expect(m.to).toEqual(["sam@example.com"]);
    expect(m.from).toBe("Acme <no-reply@example.com>");
    expect(m.html).toContain("<b>Sam</b> — see you soon");
    expect(m.html).toContain("\n.dot-stuffed line");
    expect(m.text?.trim()).toBe("Hello Sam");
  });

  it("only listens on this machine and times out plainly", async () => {
    catcher = await startMailCatcher(0);
    await expect(catcher.waitFor(() => true, 50)).rejects.toThrow(/no matching email arrived/);
  });

  it("says when the port is taken", async () => {
    catcher = await startMailCatcher(0);
    await expect(startMailCatcher(catcher.port)).rejects.toThrow(/already in use/);
  });
});

describe("parseMessage", () => {
  it("decodes a base64 single-part HTML body and encoded-word headers", () => {
    const raw = ["Subject: =?UTF-8?B?Q2Fmw6k=?=", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from("<p>Café</p>").toString("base64")].join("\r\n");
    const m = parseMessage(raw, { to: ["a@example.com"] });
    expect(m.subject).toBe("Café");
    expect(m.html).toBe("<p>Café</p>");
  });

  it("joins adjacent encoded words", () => {
    expect(decodeWords("=?utf-8?Q?Hello?= =?utf-8?Q?_there?=")).toBe("Hello there");
  });
});
