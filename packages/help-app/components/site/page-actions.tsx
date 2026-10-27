// The action row on a guide: print it, download its PDF guide or one-page quick-reference card
// (both written by the engine's pdf stage into public/pdf/ and linked from page frontmatter).
"use client";

import { Download, FileText, Printer } from "lucide-react";
import type { ReactNode } from "react";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-[var(--brand-radius)] border border-fd-border bg-fd-card px-3 py-1.5 text-sm font-medium text-fd-foreground shadow-xs transition hover:border-fd-primary/40 hover:text-fd-primary focus-visible:outline-2 focus-visible:outline-fd-ring [&_svg]:size-4 [&_svg]:text-fd-muted-foreground hover:[&_svg]:text-fd-primary";

function Action({ href, children, title }: { href: string; children: ReactNode; title: string }) {
  return (
    <a href={href} download className={BUTTON} title={title}>
      {children}
    </a>
  );
}

export function PageActions({ pdf, pdfCard }: { pdf?: string; pdfCard?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <button type="button" onClick={() => window.print()} className={BUTTON}>
        <Printer /> Print
      </button>
      {pdf ? (
        <Action href={pdf} title="This guide as a PDF, with large screenshots">
          <Download /> PDF guide
        </Action>
      ) : null}
      {pdfCard ? (
        <Action href={pdfCard} title="A one-page summary to keep by the desk">
          <FileText /> Quick-reference card
        </Action>
      ) : null}
    </div>
  );
}
