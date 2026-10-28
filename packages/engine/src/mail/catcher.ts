// A local SMTP catcher for capture (config `mail.port`): the app under capture sends its email to
// this machine instead of a real mail server, and a walkthrough's `showEmail` action shows the
// message on screen. Nothing is ever relayed. It listens on 127.0.0.1 only, accepts any sender,
// recipient and login, and keeps the messages in memory for the run.
import { createServer, type Server, type Socket } from "node:net";
import { parseMessage, type CaughtEmail } from "./parse.js";

export type { CaughtEmail } from "./parse.js";

export interface MailCatcher {
  port: number;
  /** Every message caught so far, oldest first. */
  messages(): CaughtEmail[];
  /** Resolves with the newest message `match` accepts, waiting up to `timeoutMs` for one. */
  waitFor(match: (m: CaughtEmail) => boolean, timeoutMs: number): Promise<CaughtEmail>;
  close(): Promise<void>;
}

/** Starts the catcher on 127.0.0.1:`port` (0 picks a free port). */
export async function startMailCatcher(port: number): Promise<MailCatcher> {
  const caught: CaughtEmail[] = [];
  const waiters = new Set<() => void>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, (raw, envelope) => {
      caught.push(parseMessage(raw, envelope));
      for (const wake of [...waiters]) wake();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`mail catcher: port ${port} is already in use on 127.0.0.1 (another mail catcher, or config mail.port clashes with something else)`)
          : err,
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    port: actualPort,
    messages: () => [...caught],
    waitFor(match, timeoutMs) {
      const newest = () => [...caught].reverse().find(match);
      const found = newest();
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const wake = () => {
          const m = newest();
          if (!m) return;
          waiters.delete(wake);
          clearTimeout(timer);
          resolve(m);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`no matching email arrived within ${Math.round(timeoutMs / 1000)}s (${caught.length} caught this run)`));
        }, timeoutMs);
        waiters.add(wake);
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** One SMTP conversation: enough of RFC 5321 for an app's mailer (nodemailer and the like). */
function serve(socket: Socket, onMessage: (raw: string, envelope: { from?: string; to: string[] }) => void): void {
  let buffer = "";
  let inData = false;
  let authStep: "login-user" | "login-pass" | "plain" | undefined;
  let envelope: { from?: string; to: string[] } = { to: [] };
  const reply = (line: string) => socket.write(`${line}\r\n`);
  socket.setEncoding("latin1");
  reply("220 localhost AIDA mail catcher");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        const atStart = buffer.startsWith(".\r\n");
        if (end < 0 && !atStart) return;
        const body = atStart ? "" : buffer.slice(0, end);
        buffer = atStart ? buffer.slice(3) : buffer.slice(end + 5);
        inData = false;
        // Dot-stuffing: a line starting ".." was sent as "." + the line.
        onMessage(body.replace(/^\.\./gm, "."), envelope);
        envelope = { to: [] };
        reply("250 OK: caught");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      if (authStep) {
        if (authStep === "login-user") {
          authStep = "login-pass";
          reply("334 UGFzc3dvcmQ6");
        } else {
          authStep = undefined;
          reply("235 Authentication succeeded");
        }
        continue;
      }
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          reply("250-localhost");
          reply("250-AUTH PLAIN LOGIN");
          reply("250-8BITMIME");
          reply("250 SMTPUTF8");
          break;
        case "HELO":
          reply("250 localhost");
          break;
        case "AUTH": {
          const [mech, initial] = arg.split(" ");
          if (/^plain$/i.test(mech ?? "")) {
            if (initial) reply("235 Authentication succeeded");
            else {
              authStep = "plain";
              reply("334 ");
            }
          } else if (/^login$/i.test(mech ?? "")) {
            authStep = initial ? "login-pass" : "login-user";
            reply(initial ? "334 UGFzc3dvcmQ6" : "334 VXNlcm5hbWU6");
          } else reply("504 Unrecognized authentication type");
          break;
        }
        case "MAIL":
          envelope.from = /<([^>]*)>/.exec(arg)?.[1];
          reply("250 OK");
          break;
        case "RCPT": {
          const to = /<([^>]*)>/.exec(arg)?.[1];
          if (to) envelope.to.push(to);
          reply("250 OK");
          break;
        }
        case "DATA":
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
          break;
        case "RSET":
          envelope = { to: [] };
          reply("250 OK");
          break;
        case "NOOP":
          reply("250 OK");
          break;
        case "QUIT":
          reply("221 Bye");
          socket.end();
          return;
        case "STARTTLS":
          reply("454 TLS not available");
          break;
        default:
          reply("502 Command not implemented");
      }
    }
  });
  socket.on("error", () => {});
}
