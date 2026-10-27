// Regression test for the "page-level default masking" fix: personal data in lists/tables must
// be blurred before every screenshot even when a step's own `mask` field list doesn't name it —
// e.g. a competitors table showing a real-looking email/phone in a column a walkthrough step
// never explicitly masks. example.com emails and the reserved fictional phone ranges (typical
// demo data) must stay visible, since they're already safe by convention.
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { applyMasks, applyPersonalDataMask, clearMasks } from "../../src/capture/mask.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await clearMasks(page);
});

async function filterOf(id: string): Promise<string> {
  return page.evaluate((elId) => (document.getElementById(elId) as HTMLElement).style.filter, id);
}

describe("applyPersonalDataMask", () => {
  it("blurs a real-looking email in a table row, leaves an example.com email alone", async () => {
    await page.setContent(`
      <table>
        <tr><td id="real">sophie.harrington@gmail.com</td></tr>
        <tr><td id="fake">sophie.harrington@example.com</td></tr>
      </table>
    `);

    await applyPersonalDataMask(page);

    expect(await filterOf("real")).toBe("blur(8px)");
    expect(await filterOf("fake")).toBe("");
  });

  it("blurs a real-looking phone number, leaves the reserved fictional AU mobile range alone", async () => {
    await page.setContent(`
      <ul>
        <li id="real">0412 345 678</li>
        <li id="fake">0491 570 156</li>
      </ul>
    `);

    await applyPersonalDataMask(page);

    expect(await filterOf("real")).toBe("blur(8px)");
    expect(await filterOf("fake")).toBe("");
  });

  it("leaves unrelated text alone", async () => {
    await page.setContent(`<p id="p1">Riverbend Show 2026</p>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("p1")).toBe("");
  });
});

describe("applyPersonalDataMask dirty-flag rescan (M11 perf fix: scan once per DOM change, not every call)", () => {
  it("picks up a new real-looking email added to the page after an earlier scan found nothing", async () => {
    await page.setContent(`<div id="row">Riverbend Show 2026</div>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("");

    // Mutate the DOM in place (no setContent/navigation) — this must mark the cached scan dirty
    // so the next call re-walks the page rather than reusing the (now stale) "nothing found" result.
    await page.evaluate(() => {
      const el = document.getElementById("row")!;
      el.textContent = "Contact: sophie.harrington@gmail.com";
    });
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");
  });

  it("keeps re-blurring the same flagged element across repeated calls with no DOM change in between", async () => {
    await page.setContent(`<div id="row">Contact: sophie.harrington@gmail.com</div>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");

    // clearMasks() (as runner.ts's shot() does after every screenshot) strips the blur without
    // mutating text content — the next applyPersonalDataMask() call must still re-apply it from
    // the cached flagged-element list, not skip masking because nothing "changed".
    await clearMasks(page);
    expect(await filterOf("row")).toBe("");
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");
  });

  it("rescans fresh after page.setContent() replaces the document, even though window state survives", async () => {
    await page.setContent(`<div id="a">sophie.harrington@gmail.com</div>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("a")).toBe("blur(8px)");

    // A brand-new document (setContent) with a brand-new id — must not reuse the old document's
    // cached flagged elements (which are now disconnected) nor treat the new content as unscanned.
    await page.setContent(`<div id="b">jamie.reyes@hotmail.com</div>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("b")).toBe("blur(8px)");
  });
});

describe("applyMasks default personal-data masking", () => {
  it("masks a real email in a list even when the step's own mask list is empty", async () => {
    await page.setContent(`<div id="row">Contact: jamie.reyes@hotmail.com</div>`);

    await applyMasks(page, undefined);
    expect(await filterOf("row")).toBe("blur(8px)");

    await clearMasks(page);
  });

  it("skips the personal-data scan when personalData: false is passed", async () => {
    await page.setContent(`<div id="row">Contact: jamie.reyes@hotmail.com</div>`);

    await applyMasks(page, undefined, { personalData: false });
    expect(await filterOf("row")).toBe("");
  });

  it("always blurs elements matching config.mask.selectors, regardless of scanning", async () => {
    await page.setContent(`<div id="avatar">Riverbend Show 2026</div>`);

    await applyMasks(page, undefined, { selectors: ["#avatar"] });
    expect(await filterOf("avatar")).toBe("blur(8px)");

    await clearMasks(page);
  });
});

describe("applyPersonalDataMask mixed content and form state (bug: scan skipped elements with " + "child elements, and never looked at input/textarea/select values)", () => {
  it("blurs a <td> whose phone number is split across a text node and a child element", async () => {
    // Old scan did `if (el.children.length > 0) continue`, so a <td> with any child element (the
    // <b>) was skipped entirely, even though the phone number itself is plain text content.
    await page.setContent(`<table><tr><td id="row">Call <b>Jo</b> on 0412 345 678</td></tr></table>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");
  });

  it("leaves a mixed-content element alone when only the fictional-range phone appears", async () => {
    await page.setContent(`<table><tr><td id="row">Call <b>Jo</b> on 0491 570 156</td></tr></table>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("");
  });

  it("blurs an <input> whose current value (never a text node) contains a real email", async () => {
    await page.setContent(`<input id="field" value="sophie.harrington@gmail.com" />`);
    await applyPersonalDataMask(page);
    expect(await filterOf("field")).toBe("blur(8px)");
  });

  it("blurs a <textarea> whose value contains a real phone number", async () => {
    await page.setContent(`<textarea id="field">Reach me on 0412 345 678</textarea>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("field")).toBe("blur(8px)");
  });

  it("blurs a <select> whose selected option text contains a real email", async () => {
    await page.setContent(`
      <select id="field">
        <option value="a">Riverbend Show</option>
        <option value="b" selected>sophie.harrington@gmail.com</option>
      </select>
    `);
    await applyPersonalDataMask(page);
    expect(await filterOf("field")).toBe("blur(8px)");
  });
});

describe("applyPersonalDataMask rescans on attribute changes and typing (bug: MutationObserver " + "ignored attributes entirely, so a class/style reveal or typed value was never rescanned)", () => {
  it("rescans when a previously-hidden element becomes visible via a class/style attribute change", async () => {
    await page.setContent(`
      <style>.hidden { display: none; }</style>
      <div id="row" class="hidden">sophie.harrington@gmail.com</div>
    `);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("");

    await page.evaluate(() => document.getElementById("row")!.classList.remove("hidden"));
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");
  });

  it("rescans after a value is typed into a field with no DOM mutation (input event)", async () => {
    await page.setContent(`<input id="field" />`);
    await applyPersonalDataMask(page);
    expect(await filterOf("field")).toBe("");

    await page.locator("#field").pressSequentially("sophie.harrington@gmail.com");
    await applyPersonalDataMask(page);
    expect(await filterOf("field")).toBe("blur(8px)");
  });

  it("does not treat the masking code's own style/data-aida-masked attribute writes as a reason to rescan", async () => {
    await page.setContent(`<div id="row">sophie.harrington@gmail.com</div>`);
    await applyPersonalDataMask(page);
    expect(await filterOf("row")).toBe("blur(8px)");

    // clearMasks() removes the attribute/style the mask itself set — must not mark dirty.
    await clearMasks(page);
    const dirtyAfterClear = await page.evaluate(
      () => (window as unknown as { __aidaPersonalMaskState?: { dirty: boolean } }).__aidaPersonalMaskState?.dirty,
    );
    expect(dirtyAfterClear).toBe(false);
  });
});

describe("applyPersonalDataMask fails closed (bug: every masking path caught and swallowed its own errors)", () => {
  it("throws a short 'masking failed' error instead of silently shipping an unmasked screenshot", async () => {
    await page.setContent(`<div id="row">sophie.harrington@gmail.com</div>`);
    // Break `document.createTreeWalker` so the in-page scan throws.
    await page.evaluate(() => {
      // @ts-expect-error -- deliberately breaking the DOM API under test
      document.createTreeWalker = () => {
        throw new Error("boom");
      };
    });
    await expect(applyPersonalDataMask(page)).rejects.toThrow(/masking failed/);
  });
});
