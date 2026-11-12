// Tour hints (M46): while capture has an action's element on screen, a small description of it
// (tag, role, accessible name, label, text, test id, stable id, ...) goes into the manifest, so
// the in-app tour (help app `public/tour.js`) can find the same element in the reader's browser.
//
// The in-page helpers below are shared with tour.js, which carries a byte-identical copy between
// its `aida-hints:start`/`aida-hints:end` markers (test/tours/shared-helpers.test.ts checks): a
// name capture computes one way and the tour another would never match. They never read what a
// person typed: no `.value`, no text inside fields or editable regions.
//
// Safe by default: every value passes the redaction capture's reports use and is dropped (not
// rewritten) when redaction would change it; a masked element keeps only what identifies it
// structurally; values holding the run id, generated-looking ids and ids naming a record
// (`delete-42`) are left out, which also keeps the manifest identical across runs. Blur is tested
// here against the step's own boxes and again at build time against the whole screen's, as the
// video blurs (tours/build.ts), from the boxes kept in each action's `at`. Recording never fails
// a capture: one evaluate per target, every error swallowed.
import type { Locator, Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import { looksLikeId } from "../routes/pattern.js";
import { shortLabelText, stripHintMarkers } from "./label-text.js";
import { isOpaqueSegment, redactSnapshot } from "./redact.js";
import type { Box, ElementHints, Point, ResolvedBox, StepTourHints, TourActionHints } from "./types.js";

/** Longest name/label/text kept; a longer value is kept as its first HINT_CAP characters, which
 * tour.js then matches as a prefix. Same number as `AIDA_CAP` in the helpers. */
export const HINT_CAP = 80;

/**
 * Browser-side helpers, ES5, shared with public/tour.js (see the module comment). `String.raw`
 * so the text here and in tour.js read the same, backslashes included.
 */
export const ELEMENT_HINT_HELPERS = String.raw`var AIDA_CAP = 80;
var AIDA_TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
var AIDA_FIELD_ROLES = { textbox: 1, searchbox: 1, combobox: 1, listbox: 1, spinbutton: 1, slider: 1 };
var AIDA_NO_CONTENT_NAME = { dialog: 1, alertdialog: 1, form: 1, group: 1, region: 1, navigation: 1, main: 1, complementary: 1, banner: 1, contentinfo: 1, table: 1, grid: 1, list: 1, menu: 1, menubar: 1, tablist: 1, tabpanel: 1, tree: 1, radiogroup: 1, toolbar: 1, article: 1, document: 1 };
var AIDA_CONTAINER = "dialog,[role=dialog],[role=alertdialog],fieldset,[role=group],[role=region],section,form,[role=form],nav,[role=navigation],aside,[role=complementary],tr,[role=row],li,[role=listitem],[role=tabpanel],[role=menu],article,table,[role=table],[role=grid]";
var AIDA_BLOCK = /^(DIV|P|LI|TD|TH|TR|BR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|UL|OL|TABLE|TBODY|THEAD|DT|DD|LABEL|BUTTON|NAV|ASIDE|FORM|FIELDSET|LEGEND)$/;

function aidaClean(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function aidaImplicitRole(el) {
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
    if (type === "hidden" || type === "file") return "";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "dialog") return "dialog";
  if (tag === "fieldset") return "group";
  if (tag === "tr") return "row";
  if (tag === "li") return "listitem";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "table") return "table";
  if (tag === "img") return "img";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "aside") return "complementary";
  if (tag === "article") return "article";
  if (tag === "section" && (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"))) return "region";
  if (el.isContentEditable) return "textbox";
  return "";
}

function aidaRole(el) {
  var r = aidaClean(el.getAttribute("role")).split(" ")[0];
  return (r || aidaImplicitRole(el)).toLowerCase();
}

function aidaIsField(el) {
  var tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable || AIDA_FIELD_ROLES[aidaRole(el)] === 1;
}

function aidaTextOf(node) {
  var out = "";
  var kids = node.childNodes;
  for (var i = 0; i < kids.length && out.length < 400; i++) {
    var k = kids[i];
    if (k.nodeType === 3) {
      out += k.data;
      continue;
    }
    if (k.nodeType !== 1) continue;
    var tag = k.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") continue;
    if (k.hidden || k.getAttribute("aria-hidden") === "true" || k.isContentEditable) continue;
    var gap = AIDA_BLOCK.test(tag) ? " " : "";
    if (tag === "IMG") {
      out += " " + (k.getAttribute("alt") || "") + " ";
      continue;
    }
    var aria = k.getAttribute("aria-label");
    if (aria) {
      out += " " + aria + " ";
      continue;
    }
    out += gap + aidaTextOf(k) + gap;
  }
  return out;
}

function aidaByIds(ids) {
  var parts = aidaClean(ids).split(" ");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var e = parts[i] ? document.getElementById(parts[i]) : null;
    if (e) out.push(e.getAttribute("aria-label") || aidaTextOf(e));
  }
  return out.join(" ");
}

function aidaLabelOf(label) {
  var clone = label.cloneNode(true);
  var inner = clone.querySelectorAll("input,select,textarea,[role]");
  for (var i = 0; i < inner.length; i++) if (inner[i].parentNode) inner[i].parentNode.removeChild(inner[i]);
  return aidaClean(aidaTextOf(clone));
}

function aidaLabelText(el) {
  var labels = el.labels;
  var label = labels && labels.length ? labels[0] : el.closest ? el.closest("label") : null;
  if (label) return aidaLabelOf(label);
  var by = el.getAttribute("aria-labelledby");
  return by ? aidaClean(aidaByIds(by)) : "";
}

function aidaAccName(el) {
  var by = el.getAttribute("aria-labelledby");
  if (by) {
    var t = aidaClean(aidaByIds(by));
    if (t) return t;
  }
  var aria = aidaClean(el.getAttribute("aria-label"));
  if (aria) return aria;
  var tag = el.tagName;
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "INPUT" && (type === "submit" || type === "button" || type === "reset")) return aidaClean(el.getAttribute("value"));
  if (tag === "INPUT" && type === "image") return aidaClean(el.getAttribute("alt"));
  if (tag === "IMG") return aidaClean(el.getAttribute("alt")) || aidaClean(el.getAttribute("title"));
  if (aidaIsField(el)) return aidaLabelText(el) || aidaClean(el.getAttribute("title")) || aidaClean(el.getAttribute("placeholder"));
  if (tag === "FIELDSET") {
    var legend = el.querySelector("legend");
    if (legend) return aidaClean(aidaTextOf(legend));
  }
  if (!AIDA_NO_CONTENT_NAME[aidaRole(el)]) {
    var content = aidaClean(aidaTextOf(el));
    if (content) return content;
  }
  return aidaClean(el.getAttribute("title"));
}

function aidaTestId(el) {
  for (var i = 0; i < AIDA_TEST_ATTRS.length; i++) {
    var v = el.getAttribute(AIDA_TEST_ATTRS[i]);
    if (v) return v;
  }
  return "";
}

function aidaContainerName(node) {
  var by = node.getAttribute("aria-labelledby");
  if (by) {
    var t = aidaClean(aidaByIds(by));
    if (t) return t;
  }
  var aria = aidaClean(node.getAttribute("aria-label"));
  if (aria) return aria;
  if (node.tagName === "FIELDSET") {
    var legend = node.querySelector("legend");
    if (legend) return aidaClean(aidaTextOf(legend));
  }
  var role = aidaRole(node);
  if (role === "row" || role === "listitem") return aidaClean(aidaTextOf(node));
  return "";
}

function aidaContainer(el) {
  var node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.matches(AIDA_CONTAINER) && (aidaContainerName(node) || aidaTestId(node))) return node;
    node = node.parentElement;
  }
  return null;
}
`;

/** Capture-only: what the helpers say about one element, plus where its words came from. Raw;
 * `cleanHints` decides what of it may be kept.
 *
 * Masking (config `mask.selectors`, and anything capture has marked masked) hides an element's
 * words when a selector matches the element, an ancestor or anything inside it, and the same for
 * every other element its words come from: its `<label>` and the elements `aria-labelledby`
 * points at. A container is tested the same way, so a row with one masked cell keeps no name. */
const DESCRIBE_SOURCE = String.raw`
var sels = arg.maskSelectors.concat(["[data-aida-masked]"]);
function aidaMaskedNode(n) {
  if (!n || n.nodeType !== 1) return false;
  for (var i = 0; i < sels.length; i++) {
    try {
      if (n.closest(sels[i]) || n.querySelector(sels[i])) return true;
    } catch (e) {
      // A selector the browser can't read: capture's own masking fails the step on it, so treat
      // it as matching rather than keep words it might have hidden.
      return true;
    }
  }
  return false;
}
function aidaSources(el, container) {
  var out = [el];
  var by = aidaClean(el.getAttribute("aria-labelledby"));
  var parts = by ? by.split(" ") : [];
  for (var i = 0; i < parts.length; i++) {
    var ref = document.getElementById(parts[i]);
    if (ref) out.push(ref);
  }
  if (!container && aidaIsField(el)) {
    var labels = el.labels;
    var label = labels && labels.length ? labels[0] : el.closest ? el.closest("label") : null;
    if (label) out.push(label);
  }
  return out;
}
function aidaBoxes(nodes) {
  var out = [];
  for (var i = 0; i < nodes.length && out.length < 6; i++) {
    var r = nodes[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
}
function aidaMasked(nodes) {
  for (var i = 0; i < nodes.length; i++) if (aidaMaskedNode(nodes[i])) return true;
  return false;
}
function aidaDescribeOne(el, container) {
  var out = { tag: el.tagName.toLowerCase() };
  var role = aidaRole(el);
  if (role) out.role = role;
  var name = container ? aidaContainerName(el) : aidaAccName(el);
  if (name) out.name = name;
  var tid = aidaTestId(el);
  if (tid) out.testId = tid;
  if (el.id) out.id = el.id;
  var sources = aidaSources(el, container);
  out.masked = aidaMasked(sources);
  out.boxes = aidaBoxes(sources);
  if (container) return out;
  var field = aidaIsField(el);
  if (field) {
    var label = aidaLabelText(el);
    if (label) out.label = label;
  } else {
    var text = aidaClean(aidaTextOf(el));
    if (text) out.text = text;
  }
  var nm = el.getAttribute("name");
  if (nm) out.nameAttr = nm;
  var ph = el.getAttribute("placeholder");
  if (ph) out.placeholder = aidaClean(ph);
  if (el.tagName === "INPUT" || el.tagName === "BUTTON") {
    var type = el.getAttribute("type");
    if (type) out.type = type.toLowerCase();
  }
  if (el.tagName === "A" && el.getAttribute("href") != null) {
    try {
      var u = new URL(el.getAttribute("href"), location.href);
      if (u.origin === location.origin) out.href = u.pathname;
    } catch (e) {}
  }
  return out;
}
var out = aidaDescribeOne(el, false);
if (arg.within) {
  var c = aidaContainer(el);
  if (c) out.within = aidaDescribeOne(c, true);
}
out.scroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
return out;
`;

interface RawHints {
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  within?: RawHints;
  /** A mask selector matched this element or one its words come from (see DESCRIBE_SOURCE). */
  masked?: boolean;
  /** Viewport boxes of the element and every element its words come from. */
  boxes?: Box[];
  scroll?: Point;
}

// A function built from source text, not a TS arrow: tsx can wrap a named TS function in
// `__name(...)`, which doesn't exist in the page (see init-scripts.ts). Playwright sends its
// `toString()`, so the helpers travel with it and nothing is installed on the app's page.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const describeInPage = new Function("el", "arg", `${ELEMENT_HINT_HELPERS}\n${DESCRIBE_SOURCE}`) as (
  el: Element,
  arg: { maskSelectors: string[]; within: boolean },
) => RawHints;

/** A digit run at the start or after `-`, `_`, `:` or `[` (`delete-42`, `row_7`, `order:981`,
 * `items[3]`), or any run of three or more: a record's number, not a word a person wrote. */
const RECORD_NUMBER = /(?:^|[-_:[])\d|\d{3,}/;

/**
 * True when an attribute value (an id, a test id, a `name`) reads as naming one record rather than
 * a control: it holds a record number (see RECORD_NUMBER) or a part that reads as a record id or
 * an opaque token. Such a value differs between runs that create the record, and in the reader's
 * app it would find *their* record of that number, a confident wrong match.
 */
export function looksRecordish(value: string): boolean {
  if (RECORD_NUMBER.test(value)) return true;
  return value.split(/[-_:./[\]\s]+/).some((part) => part !== "" && (looksLikeId(part) || isOpaqueSegment(part)));
}

/** True for an id an app wrote by hand (`first-name`, `save`), false for one a framework
 * generated (`:r1:`, `radix-:r3:`, `mui-12345`, `headlessui-menu-button-7`) or a record's
 * (`delete-42`, `row-7`; see `looksRecordish`). */
export function isStableId(id: string): boolean {
  if (!id || id.length > 64) return false;
  if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
  if (/^(?:radix|headlessui|mui|react-aria|react-select|rc|downshift|chakra|mantine|ember|ext-gen|yui|ng-)[-_]?/i.test(id)) return false;
  if (looksRecordish(id)) return false;
  return true;
}

/** A pathname with record ids, opaque tokens and anything holding the run id as `*`: what a tour
 * may know about where an element was, and the same on every run. */
export function pathHint(pathname: string, runId?: string): string {
  const segments = pathname
    .split(/[?#]/)[0]!
    .split("/")
    .filter(Boolean)
    .map((s) => {
      let seg = s;
      try {
        seg = decodeURIComponent(s);
      } catch {
        // keep as written
      }
      return looksLikeId(seg) || isOpaqueSegment(seg) || (runId && seg.includes(runId)) || redactSnapshot(seg) !== seg ? "*" : s;
    });
  return `/${segments.join("/")}`;
}

/** The pathname of `url` as a `pathHint`, or undefined for a page that isn't a web page. */
export function urlPathHint(url: string, runId?: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return pathHint(u.pathname, runId);
  } catch {
    return undefined;
  }
}

/** A text value as it may be stored: whitespace-normalised, capped, or undefined when it's empty,
 * holds the run id, or redaction would change it. */
function safeText(value: string | undefined, runId: string | undefined, cap = HINT_CAP): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return undefined;
  if (runId && v.includes(runId)) return undefined;
  if (redactSnapshot(v) !== v) return undefined;
  return v.slice(0, cap);
}

/** An attribute value used verbatim by the tour (id, test id, `name`): kept only whole, and never
 * one that names a record (`looksRecordish`). */
function safeAttr(value: string | undefined, runId: string | undefined): string | undefined {
  if (typeof value !== "string" || !value || value.length > HINT_CAP) return undefined;
  if (runId && value.includes(runId)) return undefined;
  if (redactSnapshot(value) !== value) return undefined;
  if (looksRecordish(value)) return undefined;
  return value;
}

const FIELD_TAGS = new Set(["input", "select", "textarea"]);
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"]);

/** True when the hints describe a form field (whose label a step's `mask` can name). */
export function isFieldHint(h: { tag: string; role?: string; label?: string }): boolean {
  return h.label !== undefined || FIELD_TAGS.has(h.tag) || (h.role !== undefined && FIELD_ROLES.has(h.role));
}

function maskWords(text: string): string {
  return ` ${stripHintMarkers(shortLabelText(text))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/**
 * True when one of a step's `mask` field names could name a field called any of `names`. Capture
 * masks every field with that label however an action reaches it, and matches labels loosely
 * (locate.ts `resolveLabel`: case, a trailing `*` or `:`, "(Required)"), so this matches more
 * loosely still: the mask's words anywhere in the name. Showing no example is the safe side.
 */
export function masksField(mask: readonly string[] | undefined, ...names: (string | undefined)[]): boolean {
  if (!mask || mask.length === 0) return false;
  for (const m of mask) {
    const want = maskWords(m);
    if (!want.trim()) continue;
    for (const n of names) if (n && maskWords(n).includes(want)) return true;
  }
  return false;
}

export interface CleanHintOptions {
  runId?: string;
  /** The element is a field the step masks by label (`step.mask`): the label stays, nothing
   * shown inside the field does. */
  maskedField?: boolean;
  /** The element's words are under a config `mask.selectors` match or a blur box: only what
   * identifies it structurally stays. */
  hidden?: boolean;
  /** The same for the `within` container. */
  withinHidden?: boolean;
}

/** What may be stored of an element's raw description (see the module comment), in a fixed key
 * order; undefined when nothing identifying is left. Also takes stored `ElementHints`, to hide
 * more of them later (tours/build.ts, per-screen blur). */
export function cleanHints(raw: RawHints | ElementHints | undefined, opts: CleanHintOptions = {}, container = false): ElementHints | undefined {
  if (!raw || typeof raw.tag !== "string" || !/^[a-z][a-z0-9-]*$/.test(raw.tag)) return undefined;
  const { runId } = opts;
  const hidden = Boolean(opts.hidden || (raw as RawHints).masked);
  const maskedField = Boolean(opts.maskedField);
  const label = hidden ? undefined : safeText(raw.label, runId);
  let name = hidden ? undefined : safeText(raw.name, runId);
  if (maskedField && name !== label) name = undefined;
  const text = hidden || maskedField ? undefined : safeText(raw.text, runId);
  const id = raw.id && isStableId(raw.id) ? safeAttr(raw.id, runId) : undefined;
  const href = hidden || maskedField || !raw.href ? undefined : pathHint(raw.href, runId);
  const out: ElementHints = { tag: raw.tag };
  if (raw.role && /^[a-z]+$/.test(raw.role)) out.role = raw.role;
  if (name) out.name = name;
  if (label) out.label = label;
  if (text && text !== name) out.text = text;
  const testId = safeAttr(raw.testId, runId);
  if (testId) out.testId = testId;
  if (id) out.id = id;
  if (!container) {
    const nameAttr = safeAttr(raw.nameAttr, runId);
    if (nameAttr) out.nameAttr = nameAttr;
    const placeholder = hidden || maskedField ? undefined : safeText(raw.placeholder, runId);
    if (placeholder) out.placeholder = placeholder;
    if (raw.type && /^[a-z-]+$/.test(raw.type)) out.type = raw.type;
    if (href) out.href = href;
    const within = cleanHints(raw.within, { runId, hidden: opts.withinHidden }, true);
    if (within) out.within = within;
  }
  const identifying = out.testId || out.id || out.name || out.label || out.text || out.placeholder || out.nameAttr || out.href;
  return identifying ? out : undefined;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * True when any of an element's boxes (viewport px when its action ran, page scrolled to `at`)
 * meets a blur box (viewport px with the page scrolled to `doc`, when the step's boxes were
 * resolved). Tested where the element was and, when the page scrolled in between, where it was by
 * then: the video shows both moments under the same boxes.
 */
export function underBlur(boxes: readonly Box[], blur: readonly Box[], at?: Point, doc?: Point): boolean {
  if (boxes.length === 0 || blur.length === 0) return false;
  const dx = at && doc ? at.x - doc.x : 0;
  const dy = at && doc ? at.y - doc.y : 0;
  return boxes.some((r) => blur.some((b) => intersects(r, b) || ((dx !== 0 || dy !== 0) && intersects({ ...r, x: r.x + dx, y: r.y + dy }, b))));
}

export interface StepHintOptions {
  runId: string;
  /** config `mask.selectors`. */
  maskSelectors?: string[];
  /** The step's `mask` field labels. */
  stepMask?: string[];
}

/** Collects one step's tour hints while capture runs it. */
export class StepHintRecorder {
  private readonly raw: { action: number; path: string; target: Target; hints: RawHints }[] = [];
  readonly path: string | undefined;

  constructor(
    private readonly page: Page,
    private readonly opts: StepHintOptions,
  ) {
    this.path = urlPathHint(page.url(), opts.runId);
  }

  /** Describes the element `loc` resolved to for action `action`. One evaluate; never throws. */
  async record(action: number, loc: Locator, target: Target): Promise<void> {
    try {
      const path = urlPathHint(this.page.url(), this.opts.runId);
      if (!path) return;
      const hints = await loc.evaluate(describeInPage, { maskSelectors: this.opts.maskSelectors ?? [], within: Boolean(target.within || typeof target.nth === "number") }, { timeout: 2_000 });
      if (hints && typeof hints === "object") this.raw.push({ action, path, target, hints });
    } catch {
      // A hint is a nicety: a capture that worked never fails for want of one.
    }
  }

  /**
   * The step's hints for the manifest. `blur` are the step's resolved blur boxes and `scroll` the
   * page's scroll offset when they were resolved: an element under one keeps only its structural
   * hints, as the screenshot hides its words. The build tests the same boxes again per screen, as
   * the video blurs them (tours/build.ts), from the boxes and scroll kept in `at`.
   */
  finish(blur: ResolvedBox[] = [], scroll?: Point): StepTourHints {
    const actions: TourActionHints[] = [];
    const boxes = blur.map((b) => b.box);
    for (const r of this.raw) {
      const h = r.hints;
      const blurred = underBlur(h.boxes ?? [], boxes, h.scroll, scroll);
      const withinBlurred = underBlur(h.within?.boxes ?? [], boxes, h.scroll, scroll);
      // Capture masks every field the step's `mask` names, however the action reached it.
      const maskedField =
        Boolean(r.target.label && this.opts.stepMask?.includes(r.target.label)) || (isFieldHint(h) && masksField(this.opts.stepMask, h.label, h.name, h.placeholder));
      const target = cleanHints(h, { runId: this.opts.runId, maskedField, hidden: blurred, withinHidden: withinBlurred });
      const masked = maskedField || blurred || Boolean(h.masked);
      const at = {
        boxes: h.boxes ?? [],
        ...(target?.within && h.within?.boxes ? { within: h.within.boxes } : {}),
        ...(h.scroll ? { scroll: h.scroll } : {}),
      };
      // One entry per action: a repeated action index (never expected) keeps its first element.
      if (target && !actions.some((a) => a.action === r.action)) actions.push({ action: r.action, path: r.path, target, ...(masked ? { masked: true as const } : {}), at });
    }
    return { ...(this.path ? { path: this.path } : {}), ...(scroll ? { scroll } : {}), ...(actions.length > 0 ? { actions } : {}) };
  }
}

/** The page's scroll offset, for `StepHintRecorder.finish`. */
export async function pageScroll(page: Page): Promise<Point | undefined> {
  const v = (await page.evaluate("[window.scrollX, window.scrollY]").catch(() => undefined)) as [number, number] | undefined;
  return Array.isArray(v) ? { x: Math.round(Number(v[0]) || 0), y: Math.round(Number(v[1]) || 0) } : undefined;
}
