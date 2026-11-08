// Skip link (WCAG 2.2 AA 2.4.1, decision 39): off-screen until focused, first in tab order,
// straight past the nav/sidebar to the page content. Lives in the *site* layout
// (app/(site)/layout.tsx) rather than the root layout (review finding app/layout.tsx:31): its
// target, Fumadocs' `<article id="nd-page">` (fumadocs-ui's docs Container), only exists on pages
// that layout renders — not /studio, not the not-found page, and not the root layout generally.
"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** `<article id="nd-page">` isn't naturally focusable, so a plain `href="#nd-page"` scrolls to it
 * without ever moving focus there — the skip link would visually work but not actually skip
 * anything for a keyboard/screen-reader user. `tabIndex={-1}` makes it a valid fragment-navigation
 * target (programmatically focusable, never added to the normal tab order) without fumadocs'
 * own `Container` component needing to know about it. Re-applied on every path change: each
 * client-side navigation swaps in a new `#nd-page` element. */
export function SkipToContent() {
  const pathname = usePathname();
  useEffect(() => {
    const target = document.getElementById("nd-page");
    if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  }, [pathname]);

  return (
    <a href="#nd-page" className="skip-link">
      Skip to content
    </a>
  );
}
