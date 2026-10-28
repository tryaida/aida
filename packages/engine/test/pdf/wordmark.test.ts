// A wordmark logo already spells the name: printed covers show it without the name beside it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCoverHtml, pdfTheme } from "../../src/pdf/html.js";

function logo(viewBox: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "aida-pdf-logo-")), "logo.svg");
  writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect width="10" height="10"/></svg>`);
  return file;
}

describe("wordmark logos in PDFs", () => {
  it("leaves the name out beside a wordmark", () => {
    const brand = { name: "Acme", logoPath: logo("0 0 120 24") };
    expect(pdfTheme(brand).logoWide).toBe(true);
    expect(buildCoverHtml("Manual", "2026-10-28", brand)).not.toContain("<span>Acme</span>");
  });

  it("keeps the name beside a square mark", () => {
    const brand = { name: "Acme", logoPath: logo("0 0 32 32") };
    expect(pdfTheme(brand).logoWide).toBeUndefined();
    expect(buildCoverHtml("Manual", "2026-10-28", brand)).toContain("<span>Acme</span>");
  });
});
