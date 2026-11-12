/*!
 * aida "Show me" tour — guides a reader through a task inside the live app (M46).
 *
 * Usage, in the app being documented (not the help site itself):
 *   <script src="https://help.example.com/tour.js" data-help-url="https://help.example.com"
 *     referrerpolicy="no-referrer"></script>
 * then a link such as `/things?aida-tour=add-a-thing`, or `window.AidaTour.start({ id: "add-a-thing" })`
 * from a button in the app. An app served under a path adds `data-base-path="/app"` (or passes
 * `basePath` to start()): a tour's screens are relative to it.
 *
 * API: `window.AidaTour = { start({ id, helpUrl, basePath }), stop(), active() }`. `start` fetches
 * `<helpUrl>/tours/<id>.json` (written by the aida engine, tours/build.ts) and begins at once. A
 * tour opened from an `aida-tour=<id>` query parameter (which is then removed from the address)
 * only shows what it is and a Start button: anyone can write such a link, so nothing is pointed at
 * until the reader chooses to start. On load the script resumes a tour from
 * `sessionStorage["aida-tour"]` (`{ id, step, action }`, `step` the step's id; dropped when the
 * tour no longer has that step), with the help site and base path from its own script tag only.
 * It dispatches `CustomEvent("aida-tour", { detail: { type, id, step } })` on `window`, `type`
 * one of "started", "step", "finished", "stopped", `step` a 0-based index.
 *
 * What a tour does: rings the element for the current step and waits. The reader does the
 * clicking and typing; the tour never acts for them, never reads what they type (no `.value`
 * anywhere in this file), sends nothing anywhere (its two requests carry no referrer) and leaves
 * focus where the reader is working. It points at an element only on the step's own screen, and
 * when it can't find the element with certainty there (none, or more than one match) it says so
 * and links to the full guide rather than pointing at a guess. It only listens (passive
 * listeners, never `preventDefault` or `stopPropagation` on the app's events), never puts its box
 * over the ringed element (it folds to one line instead, and the reader can fold it too), and
 * never patches `history`. Inside the app's modal dialog it moves into the dialog, so it isn't
 * hidden or inert behind it.
 *
 * No build step, no dependencies; its own shadow DOM keeps the app's CSS and the tour's apart.
 */
(function () {
  "use strict";
  if (window.AidaTour) return;

  var STORAGE_KEY = "aida-tour";
  var ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  // How long a step waits for its element to appear before saying it can't find it. It keeps
  // looking afterwards, so a slow screen still gets its ring.
  var FIND_WAIT_MS = 4000;
  var ADVANCE = { click: 1, change: 1, manual: 1 };

  // The browser-side helpers capture used to describe each element (engine
  // src/capture/hints.ts, ELEMENT_HINT_HELPERS). Kept identical between the markers: a name
  // computed one way at capture and another way here would never match.
  /* aida-hints:start */
  var AIDA_CAP = 80;
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
  /* aida-hints:end */

  function warn(msg) {
    if (window.console && console.warn) console.warn("[aida tour] " + msg);
  }

  /** An http(s) URL without query, hash or trailing slash; "" for anything else. */
  function cleanHelpUrl(raw) {
    if (!raw) return "";
    try {
      var u = new URL(String(raw), location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return "";
      return (u.origin + u.pathname).replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  /** A site-relative path ("/a/b"), never a scheme, a protocol-relative "//host" or a backslash. */
  function sitePath(p) {
    if (typeof p !== "string" || p.length > 500) return "";
    return /^\/(?![\/\\])[^\s\\]*$/.test(p) ? p : "";
  }

  /** "/app/" -> "/app"; "", "/" and anything that isn't a plain path -> "" (no base path). */
  function cleanBasePath(raw) {
    var p = typeof raw === "string" ? raw.trim() : "";
    if (!p) return "";
    if (p.charAt(0) !== "/") p = "/" + p;
    p = p.replace(/\/+$/, "");
    return p && sitePath(p) ? p : "";
  }

  var currentScript = document.currentScript;
  var scriptHelpUrl = cleanHelpUrl(currentScript && currentScript.getAttribute("data-help-url"));
  // An app served under a path ("https://example.com/app") sets data-base-path="/app": a tour's
  // screens are relative to it (the engine's buildTours `basePath`), as the widget's are.
  var scriptBasePath = cleanBasePath(currentScript && currentScript.getAttribute("data-base-path"));

  // Screen patterns, as the engine writes them (engine src/routes/pattern.ts; keep in step):
  // `*` matches one path segment, a trailing `**` the rest. Query and hash ignored.
  function pathSegments(p) {
    return String(p).split("#")[0].split("?")[0].split("/").filter(Boolean);
  }
  function matchRoutePattern(pattern, pathname) {
    var want = pathSegments(pattern);
    var have = pathSegments(pathname);
    for (var i = 0; i < want.length; i++) {
      if (want[i] === "**") return true;
      if (i >= have.length) return false;
      if (want[i] !== "*" && want[i] !== have[i]) return false;
    }
    return want.length === have.length;
  }

  // --- the tour file ------------------------------------------------------------------------

  // The tour file's shape (engine src/tours/types.ts TOUR_VERSION). Any other is refused.
  var TOUR_VERSION = 2;

  function str(v, max) {
    return typeof v === "string" ? v.slice(0, max) : "";
  }

  var HINT_FIELDS = ["tag", "role", "name", "label", "text", "testId", "id", "nameAttr", "placeholder", "type", "href"];

  function cleanTarget(h, depth) {
    if (!h || typeof h !== "object" || typeof h.tag !== "string" || !/^[a-z][a-z0-9-]*$/.test(h.tag)) return null;
    var out = {};
    for (var i = 0; i < HINT_FIELDS.length; i++) {
      var v = h[HINT_FIELDS[i]];
      if (typeof v === "string" && v) out[HINT_FIELDS[i]] = v.slice(0, 200);
    }
    if (out.href && !sitePath(out.href)) delete out.href;
    if (depth === 0 && h.within) {
      var w = cleanTarget(h.within, 1);
      if (w) out.within = w;
    }
    return out;
  }

  /** A screen pattern from the file: "" for none; null for one that isn't a site path. */
  function screenField(v) {
    if (v == null || v === "") return "";
    return sitePath(v) || null;
  }

  /** The tour file, checked and copied field by field; null when it isn't one. */
  function validTour(t, id) {
    if (!t || typeof t !== "object" || t.version !== TOUR_VERSION || t.id !== id) return null;
    if (!Array.isArray(t.steps) || !t.steps.length || t.steps.length > 300) return null;
    var steps = [];
    for (var i = 0; i < t.steps.length; i++) {
      var s = t.steps[i];
      if (!s || typeof s !== "object") return null;
      // A screen that isn't a path would leave a step pointing on any screen: refuse the file.
      var screen = screenField(s.screen);
      if (screen === null) return null;
      var actions = [];
      var list = Array.isArray(s.actions) ? s.actions.slice(0, 20) : [];
      for (var j = 0; j < list.length; j++) {
        var a = list[j];
        var target = a && typeof a === "object" ? cleanTarget(a.target, 0) : null;
        var actionScreen = a && typeof a === "object" ? screenField(a.screen) : null;
        if (!target || !ADVANCE[a.advance] || actionScreen === null) continue;
        actions.push({ kind: str(a.kind, 20), target: target, example: str(a.example, 200), advance: a.advance, screen: actionScreen });
      }
      steps.push({ id: str(s.id, 200) || "step-" + (i + 1), title: str(s.title, 300), text: str(s.text, 4000), screen: screen, actions: actions });
    }
    var start = t.start && typeof t.start === "object" ? t.start : {};
    return {
      id: id,
      title: str(t.title, 300),
      guideUrl: sitePath(t.guideUrl),
      start: { path: sitePath(start.path), pattern: sitePath(start.pattern) },
      steps: steps,
    };
  }

  // --- where the reader is ------------------------------------------------------------------

  var basePath = "";

  /** `pathname` relative to the app's base path, or null when it lies outside it. */
  function relPath(pathname) {
    if (!basePath) return pathname;
    if (pathname === basePath) return "/";
    return pathname.indexOf(basePath + "/") === 0 ? pathname.slice(basePath.length) : null;
  }

  function appPath() {
    return relPath(location.pathname);
  }

  // --- finding the element ------------------------------------------------------------------

  function eqText(have, want) {
    var h = aidaClean(have).toLowerCase();
    var w = String(want).toLowerCase();
    // Capture keeps a long value as its first AIDA_CAP characters: match those as a prefix.
    return w.length >= AIDA_CAP ? h.slice(0, w.length) === w : h === w;
  }

  function attrSelector(attr, value) {
    return "[" + attr + '="' + CSS.escape(value) + '"]';
  }

  function candidatesFor(h) {
    if (!window.CSS || !CSS.escape) return [];
    var sel;
    if (h.testId) {
      sel = AIDA_TEST_ATTRS.map(function (a) {
        return attrSelector(a, h.testId);
      }).join(",");
    } else if (h.id) sel = "#" + CSS.escape(h.id);
    else if (h.nameAttr) sel = attrSelector("name", h.nameAttr);
    else {
      sel = CSS.escape(h.tag);
      if (h.role) sel += "," + attrSelector("role", h.role);
    }
    try {
      return document.querySelectorAll(sel);
    } catch (e) {
      return [];
    }
  }

  function linkMatches(el, pattern) {
    if (el.tagName !== "A") return false;
    try {
      var u = new URL(el.getAttribute("href") || "", location.href);
      var p = u.origin === location.origin ? relPath(u.pathname) : null;
      return p !== null && matchRoutePattern(pattern, p);
    } catch (e) {
      return false;
    }
  }

  /** Every hint capture recorded must hold; `text` only when there's no name to go by. */
  function matchesHints(el, h, container) {
    if (el.tagName.toLowerCase() !== h.tag) return false;
    if (h.role && aidaRole(el) !== h.role) return false;
    if (h.testId && aidaTestId(el) !== h.testId) return false;
    if (h.id && el.id !== h.id) return false;
    if (container) return !h.name || eqText(aidaContainerName(el), h.name);
    if (h.nameAttr && el.getAttribute("name") !== h.nameAttr) return false;
    if (h.type && (el.getAttribute("type") || "").toLowerCase() !== h.type) return false;
    if (h.placeholder && !eqText(el.getAttribute("placeholder"), h.placeholder)) return false;
    if (h.label && !eqText(aidaLabelText(el), h.label)) return false;
    if (h.name && !eqText(aidaAccName(el), h.name)) return false;
    if (h.text && !h.name && !eqText(aidaTextOf(el), h.text)) return false;
    if (h.href && !linkMatches(el, h.href)) return false;
    if (h.within) {
      var c = aidaContainer(el);
      if (!c || !matchesHints(c, h.within, true)) return false;
    }
    return true;
  }

  function isVisible(el) {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The one visible element the hints describe, or null: none, or more than one (no guessing). */
  function findTarget(h) {
    var list = candidatesFor(h);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (host && (el === host || host.contains(el))) continue;
      if (!matchesHints(el, h, false) || !isVisible(el)) continue;
      if (found && found !== el) return null;
      found = el;
    }
    return found;
  }

  // --- state --------------------------------------------------------------------------------

  var tour = null;
  var helpUrl = "";
  var stepIndex = 0;
  var actionIndex = 0;
  var current = null;
  var typed = false;
  var finished = false;
  // Started from a link (`?aida-tour=`): nothing is pointed at until the reader presses Start.
  var pending = false;
  var returnFocus = null;
  var loadToken = 0;
  var observer = null;
  var resizeObserver = null;
  var retryTimer = 0;
  var retryDelay = 80;
  var waitTimer = 0;
  var pollTimer = 0;
  var rafId = 0;
  var lastHref = "";
  var lastRect = "";
  var missing = "";
  // The action the page was last scrolled for: once per action, so a re-render after the reader
  // scrolled away never pulls the page back.
  var scrolledFor = "";
  // The box folded down to its first line: by the reader, or by placement when it would cover
  // the element (`autoMin`; `noAutoMin` once the reader unfolds it for this action).
  var minimised = false;
  var autoMin = false;
  var noAutoMin = false;

  function stepIdAt(i) {
    return tour && tour.steps[i] ? tour.steps[i].id : "";
  }

  // Only the tour, its step's id and the action: never the help site's address, which only the
  // script tag or a start() call may give.
  function saveAt(step, action) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: tour.id, step: stepIdAt(step), action: action }));
    } catch (e) {}
  }

  function save() {
    saveAt(stepIndex, actionIndex);
  }

  function clearSaved() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function readSaved() {
    try {
      var s = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!s || typeof s !== "object" || typeof s.id !== "string" || !ID_RE.test(s.id)) return null;
      return { id: s.id, step: typeof s.step === "string" ? s.step.slice(0, 200) : "", action: Math.max(0, Math.floor(Number(s.action) || 0)) };
    } catch (e) {
      return null;
    }
  }

  function emit(type, id, step) {
    try {
      window.dispatchEvent(new CustomEvent("aida-tour", { detail: { type: type, id: id, step: step } }));
    } catch (e) {}
  }

  function currentStep() {
    return tour ? tour.steps[stepIndex] : null;
  }

  function currentAction() {
    var s = currentStep();
    return s ? s.actions[actionIndex] || null : null;
  }

  function reducedMotion() {
    return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // --- UI -----------------------------------------------------------------------------------

  var host = null;
  var ui = {};

  var CSS_TEXT = [
    ":host{all:initial}",
    ".wrap{--p:#111827;--pf:#fff;--pt:#111827;--font:system-ui,-apple-system,'Segoe UI',sans-serif;font:14px/1.45 var(--font);color:#111827}",
    ".wrap *{box-sizing:border-box;font:inherit}",
    // The ring never takes a click: the reader clicks the element through it. `--pt` is at least
    // 4.5:1 on white; the white halo keeps it 3:1 on a dark app too.
    ".ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid var(--pt);border-radius:8px;box-shadow:0 0 0 2px #fff,inset 0 0 0 2px #fff}",
    ".pop{position:fixed;z-index:2147483647;width:min(22rem,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 18px 48px -12px rgba(15,23,42,.35);padding:14px 16px}",
    ".pop:focus{outline:none}.pop:focus-visible{outline:2px solid var(--pt);outline-offset:2px}",
    ".pop.min{width:auto;padding:8px 10px}",
    ".pop.min .title,.pop.min .text,.pop.min .example,.pop.min .note,.pop.min .nav{display:none!important}",
    ".probe{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none}",
    ".head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 4px}",
    ".pop.min .head{margin:0}",
    ".count{margin:0;font-size:12px;color:#4b5563}",
    "button.fold{padding:2px 8px;font-size:12px}",
    ".title{margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.3}",
    ".text{margin:0 0 8px;white-space:pre-line}",
    ".example{margin:0 0 8px;font-size:13px;color:#374151}.example b{font-weight:600;color:#111827}",
    ".note{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#fef3c7;color:#713f12}",
    ".note p{margin:0 0 4px}.note p:last-child{margin:0}",
    ".note a,.link{color:#713f12;text-decoration:underline}",
    ".nav{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}",
    "button{cursor:pointer;border-radius:8px;padding:6px 12px;border:1px solid #6b7280;background:#fff;color:#111827}",
    "button[disabled]{cursor:default;opacity:.55}",
    "button.primary{background:var(--p);border-color:var(--p);color:var(--pf)}",
    "button:focus-visible,a:focus-visible{outline:2px solid var(--pt);outline-offset:2px}",
    ".hidden{display:none!important}",
    ".sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    "@media (prefers-reduced-motion: no-preference){.pop{animation:aida-in .15s ease-out}@keyframes aida-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}",
  ].join("\n");

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function button(text, cls, onClick) {
    var b = make("button", cls, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // The host is a zero-size fixed box, styled inline so an app rule (`dialog > div {...}`) can't
  // give it room in the app's layout when it sits inside the app's dialog.
  var HOST_STYLE = { display: "block", position: "fixed", left: "0", top: "0", width: "0", height: "0", margin: "0", padding: "0", border: "0", "z-index": "2147483647", transform: "none", filter: "none" };

  function buildUi() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-aida-tour", "");
    for (var k in HOST_STYLE) host.style.setProperty(k, HOST_STYLE[k], "important");
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    ui.wrap = make("div", "wrap");
    ui.probe = make("div", "probe");
    ui.ring = make("div", "ring hidden");
    ui.ring.setAttribute("aria-hidden", "true");
    ui.pop = make("div", "pop");
    ui.pop.setAttribute("role", "dialog");
    ui.pop.setAttribute("aria-modal", "false");
    ui.pop.setAttribute("aria-labelledby", "aida-tour-title");
    ui.pop.setAttribute("tabindex", "-1");
    ui.head = make("div", "head");
    ui.count = make("p", "count");
    // Folds the box to one line, so it never has to sit on the app's own controls.
    ui.fold = button("Hide", "fold", toggleFold);
    ui.fold.setAttribute("aria-expanded", "true");
    ui.head.appendChild(ui.count);
    ui.head.appendChild(ui.fold);
    ui.title = make("h2", "title");
    ui.title.id = "aida-tour-title";
    ui.text = make("p", "text");
    ui.example = make("p", "example hidden");
    ui.note = make("div", "note hidden");
    ui.nav = make("div", "nav");
    ui.back = button("Back", "", back);
    // Start before a link's tour begins; Next; Finish on the last step; Close once finished.
    ui.next = button("Next", "primary", function () {
      if (pending) confirmStart();
      else if (finished) close();
      else next();
    });
    ui.end = button("End tour", "", end);
    ui.nav.appendChild(ui.back);
    ui.nav.appendChild(ui.next);
    ui.nav.appendChild(ui.end);
    ui.live = make("div", "sr-only");
    ui.live.setAttribute("aria-live", "polite");
    ui.live.setAttribute("aria-atomic", "true");
    [ui.head, ui.title, ui.text, ui.example, ui.note, ui.nav, ui.live].forEach(function (n) {
      ui.pop.appendChild(n);
    });
    ui.wrap.appendChild(ui.probe);
    ui.wrap.appendChild(ui.ring);
    ui.wrap.appendChild(ui.pop);
    shadow.appendChild(ui.wrap);
    // Escape ends the tour when pressed in the tour's own box; the app's Escape stays the app's.
    // Inside the app's modal dialog Escape is the dialog's (the browser closes it, as from any
    // control in it), so there it leaves the tour alone: End tour is the way out.
    ui.pop.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || inAppLayer()) return;
      if (finished || pending) close();
      else end();
    });
    document.documentElement.appendChild(host);
    applyTheme();
  }

  // The help site's brand (written by the aida engine, theme/write.ts), as the chat widget uses it.
  function applyTheme() {
    if (!helpUrl || !window.fetch) return;
    fetch(helpUrl + "/brand/theme.json", { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (t) {
        if (!t || !ui.wrap) return;
        var map = { primary: "--p", primaryForeground: "--pf", primaryText: "--pt", fontFamily: "--font" };
        for (var k in map) {
          if (typeof t[k] === "string" && t[k].length < 200) ui.wrap.style.setProperty(map[k], t[k]);
        }
      })
      .catch(function () {});
  }

  function focusInBox() {
    return !!host && document.activeElement === host;
  }

  /** Folding the box would hide the control the reader has focus on (Next, a link). */
  function foldHidesFocus() {
    var a = focusInBox() && host.shadowRoot ? host.shadowRoot.activeElement : null;
    return !!a && a !== ui.pop && a !== ui.fold;
  }

  function focusPop() {
    if (!ui.pop) return;
    try {
      ui.pop.focus({ preventScroll: true });
    } catch (e) {
      ui.pop.focus();
    }
  }

  function announce(text) {
    if (ui.live) ui.live.textContent = text;
  }

  function guideLink(text) {
    if (!tour.guideUrl) return null;
    var a = make("a", "", text);
    a.href = helpUrl + tour.guideUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function setNote(kind) {
    ui.note.textContent = "";
    if (!kind) {
      ui.note.classList.add("hidden");
      return;
    }
    var p = make("p");
    if (kind === "missing") p.textContent = "Can't find this on the screen. It may be on another screen, or look different here.";
    else if (kind === "refused") p.textContent = "This guide can't be shown inside the app here.";
    else p.textContent = "This step happens on another screen.";
    ui.note.appendChild(p);
    var links = make("p");
    var here = appPath();
    if (kind === "screen" && tour.start.path && tour.start.pattern && tour.start.pattern.indexOf("*") < 0 && !(here !== null && matchRoutePattern(tour.start.pattern, here))) {
      var go = make("a", "", "Go to where this starts");
      go.href = basePath + tour.start.path;
      links.appendChild(go);
      links.appendChild(document.createTextNode(" · "));
    }
    var guide = guideLink("Open the full guide");
    if (guide) links.appendChild(guide);
    if (links.childNodes.length) ui.note.appendChild(links);
    ui.note.classList.remove("hidden");
  }

  function nextLabel() {
    var s = currentStep();
    return stepIndex === tour.steps.length - 1 && actionIndex >= s.actions.length - 1 ? "Finish" : "Next";
  }

  function setFold() {
    var folded = minimised || autoMin;
    ui.pop.classList.toggle("min", folded);
    ui.fold.textContent = folded ? "Show" : "Hide";
    ui.fold.setAttribute("aria-expanded", String(!folded));
    lastRect = "";
  }

  function toggleFold() {
    if (minimised || autoMin) {
      minimised = false;
      autoMin = false;
      noAutoMin = true;
    } else minimised = true;
    setFold();
    schedule();
  }

  /** Before a link's tour begins: what it is, and Start. */
  function renderPending() {
    ui.count.textContent = "Guide";
    ui.title.textContent = tour.title || "Show me how";
    ui.text.textContent = "Step-by-step help with this task, here in the app. It points at each part of the screen and waits for you; it never clicks or types for you.";
    ui.text.classList.remove("hidden");
    ui.example.classList.add("hidden");
    setNote("");
    ui.back.classList.add("hidden");
    ui.next.textContent = "Start";
    ui.end.textContent = "Not now";
  }

  function render(stepChanged) {
    var s = currentStep();
    var act = currentAction();
    var n = tour.steps.length;
    ui.count.textContent = "Step " + (stepIndex + 1) + " of " + n;
    ui.title.textContent = s.title;
    ui.text.textContent = s.text;
    ui.text.classList.toggle("hidden", !s.text);
    ui.example.textContent = "";
    if (act && act.example) {
      ui.example.appendChild(document.createTextNode("For example: "));
      ui.example.appendChild(make("b", "", act.example));
    }
    ui.example.classList.toggle("hidden", !(act && act.example));
    ui.back.disabled = stepIndex === 0 && actionIndex === 0;
    ui.back.classList.remove("hidden");
    ui.next.textContent = nextLabel();
    ui.end.textContent = "End tour";
    setNote("");
    if (stepChanged) {
      // Said through the live region: focus stays where the reader is working (decision 39 moves
      // it to the box only when the reader is already there; see `go`).
      announce("Step " + (stepIndex + 1) + " of " + n + ". " + s.title + ". " + s.text);
      emit("step", tour.id, stepIndex);
    }
  }

  // --- placing the ring and the box ---------------------------------------------------------

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
  }

  /** Where the host's fixed boxes really start: (0, 0) unless an app container it sits in (a
   * transformed dialog) makes itself their containing block. */
  function fixedOffset() {
    var r = ui.probe.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  function overlap(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** Beside the element if there's room, else the first corner clear of it (bottom-left first:
   * apps put Save bottom-right); folded to one line when nothing clears it. Never on the ring. */
  function placeBox(r, off) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var m = 12;
    var gap = 16;
    var ring = r ? { left: r.left - 9, top: r.top - 9, right: r.right + 9, bottom: r.bottom + 9 } : null;
    for (var pass = 0; pass < 2; pass++) {
      var pw = ui.pop.offsetWidth;
      var ph = ui.pop.offsetHeight;
      var spots = [];
      if (r) {
        spots.push([clamp(r.left, m, vw - pw - m), r.bottom + gap]);
        spots.push([clamp(r.left, m, vw - pw - m), r.top - gap - ph]);
        spots.push([r.right + gap, clamp(r.top, m, vh - ph - m)]);
        spots.push([r.left - gap - pw, clamp(r.top, m, vh - ph - m)]);
      }
      spots.push([m, vh - ph - m], [vw - pw - m, vh - ph - m], [m, m], [vw - pw - m, m]);
      var best = null;
      var bestCover = Infinity;
      for (var i = 0; i < spots.length; i++) {
        var left = spots[i][0];
        var top = spots[i][1];
        if (left < m - 0.5 || top < m - 0.5 || left + pw > vw - m + 0.5 || top + ph > vh - m + 0.5) continue;
        var cover = ring ? overlap({ left: left, top: top, right: left + pw, bottom: top + ph }, ring) : 0;
        if (cover < bestCover) {
          best = spots[i];
          bestCover = cover;
        }
        if (cover === 0) break;
      }
      // Nothing clears the element: fold to one line and try again, unless the reader is using
      // the box (folding would hide the button they're on) or unfolded it themselves.
      if (bestCover > 0 && pass === 0 && !minimised && !autoMin && !noAutoMin && !foldHidesFocus()) {
        autoMin = true;
        setFold();
        continue;
      }
      if (!best) best = [vw - pw - m, vh - ph - m];
      ui.pop.style.left = Math.max(m, best[0]) - off.x + "px";
      ui.pop.style.top = Math.max(m, best[1]) - off.y + "px";
      return;
    }
  }

  function placeRing(r, off) {
    ui.ring.style.left = r.left - 6 - off.x + "px";
    ui.ring.style.top = r.top - 6 - off.y + "px";
    ui.ring.style.width = r.width + 12 + "px";
    ui.ring.style.height = r.height + 12 + "px";
    ui.ring.classList.remove("hidden");
  }

  // The app's top layer (a modal `<dialog>`, an open popover) paints over everything else, and a
  // modal makes the rest of the page inert, a focus trap (`aria-modal="true"`) the same. So the
  // host goes inside the layer its element is in (or, with no element, the open modal), and back
  // out when that closes.
  function isAppLayer(n) {
    if (n === host || n.nodeType !== 1) return false;
    if (n.tagName === "DIALOG") {
      if (!n.open) return false;
      try {
        return n.matches(":modal");
      } catch (e) {
        return true;
      }
    }
    if (n.getAttribute("aria-modal") === "true") return isVisible(n);
    if (n.hasAttribute("popover")) {
      try {
        return n.matches(":popover-open");
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function layerOf(el) {
    for (var n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (isAppLayer(n)) return n;
    }
    return null;
  }

  function openModal() {
    var list = document.querySelectorAll("dialog[open],[aria-modal=true]");
    for (var i = list.length - 1; i >= 0; i--) if (isAppLayer(list[i])) return list[i];
    return null;
  }

  function inAppLayer() {
    return !!host && host.parentNode !== document.documentElement;
  }

  function placeHost() {
    var want = (current && layerOf(current)) || openModal() || document.documentElement;
    if (host.parentNode === want) return;
    var hadFocus = focusInBox();
    want.appendChild(host);
    if (hadFocus) focusPop();
    lastRect = "";
  }

  // Repositioning runs on scroll, resize, the element or box resizing, observed page changes and
  // a slow poll (for movement nothing reports), at most once a frame: never a per-frame loop.
  function schedule() {
    if (!tour || rafId) return;
    rafId = requestAnimationFrame(update);
  }

  function update() {
    rafId = 0;
    if (!tour || !host) return;
    placeHost();
    if (!pending && !finished && location.href !== lastHref) {
      locate();
      return;
    }
    if (current && (!current.isConnected || !isVisible(current))) {
      locate();
      return;
    }
    var r = current ? current.getBoundingClientRect() : null;
    var off = fixedOffset();
    var key = (r ? [r.left, r.top, r.width, r.height].join(",") : "none") + "|" + window.innerWidth + "x" + window.innerHeight + "|" + ui.pop.offsetWidth + "x" + ui.pop.offsetHeight + "|" + off.x + "," + off.y;
    if (key === lastRect) return;
    lastRect = key;
    if (r) placeRing(r, off);
    else ui.ring.classList.add("hidden");
    placeBox(r, off);
  }

  // --- each action --------------------------------------------------------------------------

  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    clearTimeout(retryTimer);
    clearTimeout(waitTimer);
    retryTimer = 0;
    waitTimer = 0;
  }

  /** Watches the page: "eager" while a step's element is first awaited (every change, 80ms);
   * "found" while it's ringed (structure and visibility, to follow it and to notice a second
   * match); "idle" once the wait is over or the reader is elsewhere (structure only, 500ms). */
  function observe(mode) {
    if (observer) observer.disconnect();
    clearTimeout(retryTimer);
    retryTimer = 0;
    retryDelay = mode === "eager" ? 80 : mode === "found" ? 250 : 500;
    var opts = { childList: true, subtree: true };
    if (mode === "eager") {
      opts.attributes = true;
      opts.characterData = true;
    } else if (mode === "found") {
      opts.attributes = true;
      opts.attributeFilter = ["class", "style", "hidden", "open", "aria-hidden", "aria-modal"];
    }
    observer = new MutationObserver(onMutate);
    observer.observe(document.documentElement, opts);
  }

  /** True when a change is only the tour's own host coming or going. */
  function ownChange(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.target === host) continue;
      if (r.type === "childList" && r.addedNodes.length + r.removedNodes.length === 1 && (r.addedNodes[0] === host || r.removedNodes[0] === host)) continue;
      return false;
    }
    return true;
  }

  // Throttled: on a page that changes all the time this runs a few times a second, not per change.
  function onMutate(records) {
    if (ownChange(records)) return;
    if (!retryTimer) retryTimer = setTimeout(retry, retryDelay);
  }

  function screenOf(act) {
    var s = currentStep();
    return (act && act.screen) || (s && s.screen) || "";
  }

  /** The reader is on the action's screen (the step's, with none of its own); always true for a
   * step with no screen. An element is only ever ringed here. */
  function onScreen(act) {
    var screen = screenOf(act);
    if (!screen) return true;
    var here = appPath();
    return here !== null && matchRoutePattern(screen, here);
  }

  function found(el) {
    stopWatching();
    current = el;
    missing = "";
    typed = false;
    setNote("");
    ui.next.textContent = nextLabel();
    lastRect = "";
    observe("found");
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(el);
      resizeObserver.observe(ui.pop);
    }
    var key = stepIndex + ":" + actionIndex;
    if (scrolledFor !== key) {
      scrolledFor = key;
      var r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
        try {
          el.scrollIntoView({ block: "center", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
        } catch (e) {
          el.scrollIntoView();
        }
      }
    }
    schedule();
  }

  /** Says the element isn't here (or the reader is on another screen), then keeps looking, gently. */
  function showMissing() {
    waitTimer = 0;
    if (!tour || current) return;
    var kind = onScreen(currentAction()) ? "missing" : "screen";
    missing = kind;
    setNote(kind);
    ui.next.textContent = kind === "missing" ? "Skip" : nextLabel();
    announce(ui.note.textContent);
    lastRect = "";
    observe("idle");
    schedule();
  }

  function retry() {
    retryTimer = 0;
    if (!tour || pending || finished) return;
    if (location.href !== lastHref) {
      locate();
      return;
    }
    // The page changed: the ring and box may need to move.
    schedule();
    var act = currentAction();
    if (!act) return;
    if (!onScreen(act)) {
      if (current) locate();
      return;
    }
    var el = findTarget(act.target);
    // Ringed: the element went, or a second match appeared. Either way, look again from scratch.
    if (current) {
      if (el !== current) locate();
      return;
    }
    if (el) found(el);
  }

  /** Finds the current action's element on its own screen, or waits for it (bounded) and then
   * says it can't. */
  function locate() {
    stopWatching();
    current = null;
    lastRect = "";
    lastHref = location.href;
    ui.ring.classList.add("hidden");
    var act = currentAction();
    if (!act) {
      // Read-and-continue: only say so when the reader is somewhere else.
      setNote(onScreen(null) ? "" : "screen");
      observe("idle");
      schedule();
      return;
    }
    if (!onScreen(act)) {
      showMissing();
      return;
    }
    if (missing === "screen") {
      // The reader has reached the step's screen since: wait for the element as if new.
      missing = "";
      setNote("");
      ui.next.textContent = nextLabel();
    }
    var el = findTarget(act.target);
    if (el) {
      found(el);
      return;
    }
    if (missing) observe("idle");
    else {
      observe("eager");
      waitTimer = setTimeout(showMissing, FIND_WAIT_MS);
    }
    schedule();
  }

  function go(step, action) {
    var stepChanged = step !== stepIndex;
    // Focus follows into the box only when the reader is already there (they pressed Next or
    // Back); someone typing in the app keeps their place.
    var keepFocus = focusInBox();
    stepIndex = step;
    actionIndex = action;
    current = null;
    missing = "";
    typed = false;
    autoMin = false;
    noAutoMin = false;
    setFold();
    save();
    render(stepChanged);
    if (stepChanged && keepFocus) focusPop();
    locate();
  }

  function next() {
    if (!tour || finished || pending) return;
    var s = currentStep();
    if (actionIndex + 1 < s.actions.length) go(stepIndex, actionIndex + 1);
    else if (stepIndex + 1 < tour.steps.length) go(stepIndex + 1, 0);
    else finish();
  }

  function back() {
    if (!tour || finished || pending) return;
    if (actionIndex > 0) go(stepIndex, actionIndex - 1);
    else if (stepIndex > 0) go(stepIndex - 1, 0);
  }

  /** The reader did the action. The next position is saved at once (a click may be leaving the
   * page); the screen updates after the app has handled the event. */
  function did() {
    var s = currentStep();
    var stepAt = stepIndex;
    var actionAt = actionIndex;
    if (actionAt + 1 < s.actions.length) actionAt += 1;
    else {
      stepAt += 1;
      actionAt = 0;
    }
    current = null;
    if (stepAt >= tour.steps.length) clearSaved();
    else saveAt(stepAt, actionAt);
    setTimeout(function () {
      if (!tour) return;
      if (stepAt >= tour.steps.length) finish();
      else go(stepAt, actionAt);
    }, 0);
  }

  function inPath(e, el) {
    var path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(el) >= 0 || (e.target instanceof Node && el.contains(e.target));
  }

  // Passive, capture-phase listeners on window: the tour sees the reader's action before the app
  // can stop it, and never changes what the app gets.
  function onClick(e) {
    var act = currentAction();
    if (current && act && act.advance === "click" && inPath(e, current)) did();
  }
  function onChange(e) {
    var act = currentAction();
    if (current && act && act.advance === "change" && inPath(e, current)) did();
  }
  // Only that something was typed, never what.
  function onInput(e) {
    if (current && inPath(e, current)) typed = true;
  }
  // A field that never fires `change` (an editable region): leaving it after typing counts.
  function onFocusOut(e) {
    var act = currentAction();
    if (current && act && act.advance === "change" && typed && inPath(e, current)) did();
  }

  var LISTEN = { capture: true, passive: true };

  function listen(on) {
    var fn = on ? window.addEventListener : window.removeEventListener;
    fn.call(window, "click", onClick, LISTEN);
    fn.call(window, "change", onChange, LISTEN);
    fn.call(window, "input", onInput, LISTEN);
    fn.call(window, "focusout", onFocusOut, LISTEN);
    fn.call(window, "scroll", schedule, LISTEN);
    fn.call(window, "resize", schedule, LISTEN);
    fn.call(window, "transitionend", schedule, LISTEN);
    fn.call(window, "animationend", schedule, LISTEN);
  }

  // --- start, finish, end -------------------------------------------------------------------

  function finish() {
    stopWatching();
    current = null;
    finished = true;
    clearSaved();
    ui.ring.classList.add("hidden");
    ui.count.textContent = "Done";
    ui.title.textContent = tour.title;
    ui.text.textContent = "You've reached the end of this guide.";
    ui.text.classList.remove("hidden");
    ui.example.classList.add("hidden");
    setNote("");
    ui.back.classList.add("hidden");
    ui.next.textContent = "Close";
    ui.end.classList.add("hidden");
    announce("Done. You've reached the end of this guide.");
    lastRect = "";
    if (focusInBox()) focusPop();
    emit("finished", tour.id, stepIndex);
    schedule();
  }

  function teardown() {
    stopWatching();
    listen(false);
    cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(pollTimer);
    pollTimer = 0;
    // Focus goes back only from the tour's own box: a reader working in the app stays put.
    var restore = focusInBox();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    ui = {};
    tour = null;
    current = null;
    finished = false;
    pending = false;
    var prev = returnFocus;
    returnFocus = null;
    if (restore && prev && prev.isConnected && typeof prev.focus === "function") {
      try {
        prev.focus({ preventScroll: true });
      } catch (e) {}
    }
  }

  function close() {
    teardown();
  }

  function end() {
    if (!tour) return;
    var id = tour.id;
    var step = stepIndex;
    var started = !pending && !finished;
    clearSaved();
    teardown();
    if (started) emit("stopped", id, step);
  }

  /** `mode`: "control" (start() from a button in the app or the widget), "link" (an
   * `aida-tour=` parameter: waits for Start) or "resume" (the next page of a running tour). */
  function begin(t, base, bp, step, action, mode) {
    if (tour) {
      var before = returnFocus;
      end();
      returnFocus = before;
    }
    tour = t;
    helpUrl = base;
    basePath = bp;
    finished = false;
    pending = mode === "link";
    stepIndex = step;
    actionIndex = action;
    current = null;
    missing = "";
    scrolledFor = "";
    minimised = false;
    autoMin = false;
    noAutoMin = false;
    buildUi();
    listen(true);
    lastHref = location.href;
    pollTimer = setInterval(schedule, 500);
    if (pending) {
      renderPending();
      // Announced a moment after the region exists, so screen readers hear it; focus stays put.
      setTimeout(function () {
        if (tour === t && pending) announce("A guide is ready: " + (t.title || "Show me how") + ". Start it from the guide box when you want it.");
      }, 150);
      schedule();
      return;
    }
    save();
    if (mode === "control") emit("started", t.id, stepIndex);
    render(true);
    if (mode === "control") focusPop();
    locate();
  }

  /** The reader pressed Start on a link's tour. */
  function confirmStart() {
    if (!tour || !pending) return;
    pending = false;
    save();
    emit("started", tour.id, stepIndex);
    render(true);
    focusPop();
    locate();
  }

  /** A tour file of a version this script doesn't know: say so and offer the full guide. */
  function refuse(json, id, base, bp, mode) {
    if (tour) end();
    tour = { id: id, title: str(json.title, 300), guideUrl: sitePath(json.guideUrl), start: {}, steps: [] };
    helpUrl = base;
    basePath = bp;
    finished = true;
    pending = false;
    buildUi();
    ui.count.textContent = "Guide";
    ui.title.textContent = tour.title || "Show me how";
    ui.text.classList.add("hidden");
    ui.example.classList.add("hidden");
    setNote("refused");
    ui.back.classList.add("hidden");
    ui.next.textContent = "Close";
    ui.end.classList.add("hidden");
    announce(ui.note.textContent);
    pollTimer = setInterval(schedule, 500);
    listen(true);
    if (mode === "control") focusPop();
    schedule();
  }

  function indexOfStep(t, stepId) {
    for (var i = 0; i < t.steps.length; i++) if (stepId && t.steps[i].id === stepId) return i;
    return -1;
  }

  function load(id, base, bp, saved, mode) {
    var token = ++loadToken;
    if (mode === "control" && !tour) returnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    return fetch(base + "/tours/" + id + ".json", { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (token !== loadToken) return false;
        if (json && typeof json === "object" && json.id === id && json.version !== TOUR_VERSION) {
          warn("the tour " + id + " is a version this script doesn't know");
          clearSaved();
          refuse(json, id, base, bp, mode);
          return false;
        }
        var t = validTour(json, id);
        if (!t) {
          warn("couldn't load the tour " + id);
          if (mode === "resume") clearSaved();
          return false;
        }
        var step = 0;
        var action = 0;
        if (saved) {
          // By the step's id: a tour file that changed between pages resumes nowhere rather than
          // on the wrong step.
          step = indexOfStep(t, saved.step);
          if (step < 0 || saved.action > Math.max(0, t.steps[step].actions.length - 1)) {
            warn("the tour " + id + " changed since the last page: not resuming it");
            clearSaved();
            return false;
          }
          action = saved.action;
        }
        begin(t, base, bp, step, action, mode);
        return true;
      })
      .catch(function () {
        if (token === loadToken) warn("couldn't load the tour " + id);
        return false;
      });
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function startAs(opts, mode) {
    opts = opts || {};
    var id = typeof opts.id === "string" ? opts.id : "";
    if (!ID_RE.test(id)) {
      warn("refused a tour id that isn't lower-case letters, digits and dashes");
      return Promise.resolve(false);
    }
    var base = cleanHelpUrl(opts.helpUrl) || scriptHelpUrl;
    if (!base) {
      warn("no help site URL: add data-help-url to the tour.js script tag, or pass helpUrl to start()");
      return Promise.resolve(false);
    }
    var bp = cleanBasePath(opts.basePath) || scriptBasePath;
    return new Promise(function (resolve) {
      whenReady(function () {
        load(id, base, bp, null, mode).then(resolve);
      });
    });
  }

  function start(opts) {
    return startAs(opts, "control");
  }

  function stop() {
    if (tour && (finished || pending)) close();
    else end();
  }

  function active() {
    return tour && !finished && !pending ? { id: tour.id, step: stepIndex } : null;
  }

  window.AidaTour = { start: start, stop: stop, active: active };

  /** `?aida-tour=<id>`: offer it (Start first), and take the parameter out of the address. */
  function fromQuery() {
    if (!window.URLSearchParams || location.search.indexOf("aida-tour") < 0) return false;
    var params = new URLSearchParams(location.search);
    if (!params.has("aida-tour")) return false;
    var id = params.get("aida-tour") || "";
    params.delete("aida-tour");
    var qs = params.toString();
    try {
      history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    } catch (e) {}
    if (!ID_RE.test(id)) {
      warn("refused a tour id that isn't lower-case letters, digits and dashes");
      return true;
    }
    startAs({ id: id }, "link");
    return true;
  }

  function resume() {
    var saved = readSaved();
    if (!saved) return;
    // Only the script tag says where the help site and the base path are: nothing saved in the
    // tab is trusted for either.
    if (!scriptHelpUrl) {
      warn("a tour is in progress but the script tag has no data-help-url: not resuming it");
      return;
    }
    whenReady(function () {
      load(saved.id, scriptHelpUrl, scriptBasePath, saved, "resume");
    });
  }

  if (!fromQuery()) resume();
})();
