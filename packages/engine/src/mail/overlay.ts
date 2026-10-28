// Draws an email over the app page for `showEmail`: a plain mail-client card (from, to, subject,
// the body) on a dimmed backdrop, so a walkthrough can show the email a reader receives without a
// real inbox. The body is drawn in a sandboxed iframe (no scripts, no same-origin access).
import type { Page } from "playwright";

export const EMAIL_OVERLAY_ID = "aida-email-overlay";
export const EMAIL_CARD_ID = "aida-email-card";

export interface EmailView {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

/** `page.evaluate` source (a string: see capture/init-scripts.ts on `__name` under tsx). Takes
 * `{ email, overlayId, cardId }`. */
const SHOW_EMAIL_SCRIPT = `({ email, overlayId, cardId }) => {
  document.getElementById(overlayId)?.remove();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const body = email.html ?? '<div style="font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;padding:24px;white-space:pre-wrap">' + esc(email.text ?? "") + "</div>";
  const overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.setAttribute("style", "position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:3vh 4vw");
  const name = email.from.replace(/^"?([^"<]*)"?\\s*<.*$/, "$1").trim() || email.from;
  const initial = name.charAt(0).toUpperCase();
  overlay.innerHTML =
    '<div id="' + cardId + '" role="dialog" aria-label="Email: ' + esc(email.subject) + '" style="width:min(860px,100%);height:100%;max-height:900px;background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">' +
    '<div style="display:flex;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid #e5e7eb;background:#f9fafb;color:#6b7280;font-size:13px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#d1d5db"></span>Inbox</div>' +
    '<div style="padding:18px 22px 14px;border-bottom:1px solid #e5e7eb">' +
    '<div style="font-size:20px;font-weight:600;margin-bottom:12px">' + esc(email.subject) + "</div>" +
    '<div style="display:flex;gap:12px;align-items:center">' +
    '<div style="width:38px;height:38px;border-radius:50%;background:#e0e7ff;color:#3730a3;display:flex;align-items:center;justify-content:center;font-weight:600">' + esc(initial) + "</div>" +
    '<div style="min-width:0"><div style="font-weight:600">' + esc(email.from) + '</div><div style="color:#6b7280;font-size:13px">to ' + esc(email.to) + "</div></div>" +
    "</div></div>" +
    '<iframe sandbox="" title="Email body" style="flex:1;border:0;width:100%;background:#fff"></iframe></div>';
  const frame = overlay.querySelector("iframe");
  frame.srcdoc = body;
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });
}`;

/** Puts the email on screen and waits for its body (and images) to load. */
export async function showEmailOverlay(page: Page, email: EmailView): Promise<void> {
  await page.evaluate(`(${SHOW_EMAIL_SCRIPT})(${JSON.stringify({ email, overlayId: EMAIL_OVERLAY_ID, cardId: EMAIL_CARD_ID })})`);
}

/** Takes the email off screen (no-op when none is shown). */
export async function hideEmailOverlay(page: Page): Promise<void> {
  await page.evaluate(`document.getElementById(${JSON.stringify(EMAIL_OVERLAY_ID)})?.remove()`).catch(() => {});
}

/** The email card's box on screen, for a highlight. */
export async function emailCardBox(page: Page): Promise<{ x: number; y: number; w: number; h: number } | undefined> {
  const box = await page.locator(`#${EMAIL_CARD_ID}`).boundingBox().catch(() => null);
  return box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : undefined;
}
