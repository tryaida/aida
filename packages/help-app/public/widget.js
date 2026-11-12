/*!
 * aida in-app help — drop-in widget (scope.md "Help chat": "a drop-in widget inside the app
 * (one script tag or a React component)"; build-plan.md M15 step 6, M45).
 *
 * Usage, in the app being documented (not the help site itself):
 *   <script src="https://your-help-site.example.com/widget.js" data-help-url="https://your-help-site.example.com"></script>
 *
 * Opens on "Help for this screen": the published guides whose screens (help-map.json, written by
 * `aida build`) match `location.pathname`, then a search over search-index.json scored the way
 * the help site's own search scores it. Neither needs a model or a key. Help chat appears only
 * when `GET <data-help-url>/api/chat` says it's available (the owner's key is set and this app's
 * origin is listed in `chat.allowedOrigins`); on a static host that request fails and chat stays
 * hidden. When chat is there it sends `location.pathname` as `currentPath` on every question, so
 * retrieval can boost the walkthrough the reader is actually looking at.
 *
 * An app served under a path adds `data-base-path="/app"`; the widget takes it off
 * `location.pathname` before matching screens or sending the path.
 *
 * The help site must serve help-map.json, search-index.json, brand/theme.json and tours/* with
 * `Access-Control-Allow-Origin` (next.config.mjs does; a static host needs the same headers).
 *
 * No build step, no dependencies, no React required — plain DOM + fetch. For a React app,
 * import the `ChatWidget` component documented in this package's README instead.
 */
(function () {
  "use strict";

  var currentScript = document.currentScript;
  var helpUrl = (currentScript && currentScript.getAttribute("data-help-url")) || "";
  if (!helpUrl) {
    console.error("[aida widget] missing data-help-url attribute on the widget.js <script> tag");
    return;
  }
  helpUrl = helpUrl.replace(/\/$/, "");

  // An app served under a path ("https://example.com/app") sets data-base-path="/app": the help
  // map's screens are relative to it (the engine's buildHelpMap `basePath`), so it comes off the
  // reader's path before matching and before the path is sent anywhere.
  var basePath = ((currentScript && currentScript.getAttribute("data-base-path")) || "").replace(/\/+$/, "");
  if (basePath && basePath.charAt(0) !== "/") basePath = "/" + basePath;

  var busy = false;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) node.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function noop() {}

  // <match-route-pattern> Same rules as the engine's routes/pattern.ts (`*` one segment, `**` the
  // rest, only last; query, hash and trailing slash ignored). A test feeds both the same cases.
  function normalizePathname(input) {
    var path = String(input);
    var scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
    if (scheme) {
      var rest = path.slice(scheme[0].length);
      var slash = rest.indexOf("/");
      path = slash === -1 ? "/" : rest.slice(slash);
    }
    path = path.split("#")[0].split("?")[0];
    if (path.charAt(0) !== "/") path = "/" + path;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return path || "/";
  }

  function matchRoutePattern(pattern, pathname) {
    var want = normalizePathname(pattern).split("/").filter(Boolean);
    var have = normalizePathname(pathname).split("/").filter(Boolean);
    for (var i = 0; i < want.length; i++) {
      if (want[i] === "**") return true;
      if (i >= have.length) return false;
      if (want[i] !== "*" && want[i] !== have[i]) return false;
    }
    return want.length === have.length;
  }
  // </match-route-pattern>

  /** A help-site page path, or null for anything that could leave the help site (a scheme,
   * `//host`, a backslash) — fetched JSON never decides where a link goes. */
  function sitePath(url) {
    if (typeof url !== "string" || url.charAt(0) !== "/" || url.charAt(1) === "/" || /[\\\s]/.test(url)) return null;
    return url;
  }

  /** The reader's screen as the help map names it: `location.pathname` without the base path.
   * Null outside the base path: no guide is for a screen the documented app doesn't have, and
   * that path isn't sent anywhere. */
  function appPath() {
    var path = location.pathname;
    if (!basePath) return path;
    if (path === basePath) return "/";
    return path.indexOf(basePath + "/") === 0 ? path.slice(basePath.length) : null;
  }

  // Chat's stream and a turn restored from sessionStorage are both data from elsewhere: every URL
  // goes through `sitePath`, so a citation like "@evil.example.com/x" can't turn
  // `helpUrl + url` into another host, and anything of the wrong shape is dropped.
  function cleanCitations(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (c) {
        return c && typeof c.n === "number" && typeof c.title === "string" && sitePath(c.url);
      })
      .map(function (c) {
        return { n: c.n, title: c.title, url: c.url };
      });
  }

  function cleanProcedures(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (p) {
        return p && sitePath(p.url);
      })
      .map(function (p) {
        var out = { url: p.url };
        if (sitePath(p.firstScreenshot)) out.firstScreenshot = p.firstScreenshot;
        if (typeof p.stepCount === "number" && p.stepCount > 0) out.stepCount = Math.floor(p.stepCount);
        if (typeof p.firstVideoTimeSec === "number") out.firstVideoTimeSec = p.firstVideoTimeSec;
        return out;
      });
  }

  /** A saved turn as the renderer expects it, or null. */
  function cleanTurn(t) {
    if (!t || typeof t !== "object" || typeof t.text !== "string") return null;
    if (t.role === "user") return { role: "user", text: t.text };
    if (t.role !== "assistant" || t.done !== true) return null;
    var out = { role: "assistant", text: t.text, done: true, citations: cleanCitations(t.citations), procedures: cleanProcedures(t.procedures) };
    if (typeof t.error === "string") out.error = t.error;
    return out;
  }

  // Shadow DOM keeps the host app's CSS and the widget's apart in both directions.
  var host = el("div", { "data-aida-widget": "" });
  var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    ".dg{--p:#111827;--pf:#fff;--pt:#111827;--font:system-ui,-apple-system,'Segoe UI',sans-serif;position:fixed;bottom:16px;right:16px;z-index:2147483000;font:14px/1.45 var(--font);color:#111827}",
    ".dg *{box-sizing:border-box;font:inherit}",
    "[hidden]{display:none!important}",
    ".sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    ".panel{display:none;flex-direction:column;width:min(24rem,calc(100vw - 32px));height:min(34rem,calc(100vh - 32px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 24px 60px -12px rgba(15,23,42,.35);overflow:hidden}",
    ".panel.open{display:flex}",
    ".head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #eef0f3;background:#fafbfc}",
    ".mark{width:32px;height:32px;border-radius:999px;background:var(--p);color:var(--pf);display:grid;place-items:center;flex:none;overflow:hidden}",
    ".mark img{width:22px;height:22px;object-fit:contain}",
    ".grow{flex:1;min-width:0}.new{display:none}.new.show{display:block}",
    ".title{font-weight:600}.sub{font-size:12px;color:#4b5563}",
    ".x{border:0;background:none;cursor:pointer;color:#4b5563;padding:6px;border-radius:8px}.x:hover{background:#f1f3f5;color:#111827}",
    ".tabs{display:flex;gap:4px;padding:0 10px;border-bottom:1px solid #eef0f3;background:#fafbfc}",
    ".tab{border:0;border-bottom:2px solid transparent;background:none;padding:8px 10px;cursor:pointer;color:#4b5563;font-weight:600}",
    ".tab[aria-selected=true]{color:#111827;border-bottom-color:var(--pt)}",
    ".view{flex:1;min-height:0;display:flex;flex-direction:column}",
    ".find{display:flex;padding:10px 12px;border-bottom:1px solid #eef0f3}",
    ".list{flex:1;overflow-y:auto;padding:4px 12px 12px}",
    ".list h2{margin:10px 2px 6px;font-size:12px;font-weight:600;color:#4b5563;text-transform:uppercase;letter-spacing:.04em}",
    ".rows{list-style:none;margin:0;padding:0}",
    ".row{display:flex;gap:10px;align-items:flex-start;padding:10px 2px;border-bottom:1px solid #f1f3f5}",
    ".row:last-child{border-bottom:0}",
    ".row .grow a{color:var(--pt);font-weight:600;text-decoration:none}.row .grow a:hover{text-decoration:underline}",
    ".meta{display:block;font-size:12px;color:#4b5563}",
    ".sum{display:block;margin-top:2px;font-size:13px;color:#374151}",
    ".show-me{flex:none;border:0;border-radius:999px;background:var(--p);color:var(--pf);padding:5px 12px;cursor:pointer;font-size:13px;font-weight:600}",
    ".none{padding:18px 4px;color:#4b5563;text-align:center}.none b{display:block;color:#111827;margin-bottom:4px}",
    ".msgs{flex:1;overflow-y:auto;padding:14px}",
    ".empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#4b5563;gap:6px}",
    ".empty b{color:#111827}",
    ".b{margin:6px 0;padding:8px 12px;border-radius:16px;max-width:88%;word-wrap:break-word}",
    ".b.user{margin-left:auto;background:var(--p);color:var(--pf);border-bottom-right-radius:6px;white-space:pre-wrap}",
    ".b.assistant{background:#f1f3f5;border-bottom-left-radius:6px}",
    ".b p{margin:0 0 8px}.b p:last-child,.b ol:last-child,.b ul:last-child{margin-bottom:0}",
    ".b ol,.b ul{margin:0 0 8px;padding-left:20px}.b li{margin:2px 0}",
    ".b strong{font-weight:600}.b em{font-style:italic}",
    ".b code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:rgba(255,255,255,.7);border-radius:4px;padding:1px 4px}",
    // `--pt` ("primary text") is `--p` nudged for >= 4.5:1 on this panel's own white background
    // (theme.json's `primaryText`, write.ts) — `--p` itself only needs to work as a *fill*.
    ".cite{display:inline-grid;place-items:center;width:16px;height:16px;margin-left:2px;border-radius:999px;background:color-mix(in srgb,var(--p) 15%,transparent);color:var(--pt);font-size:10px;font-weight:600;text-decoration:none;vertical-align:super;line-height:1}",
    ".cite:hover{background:var(--p);color:var(--pf)}",
    ".err{color:#b91c1c}",
    ".guide{display:flex;gap:10px;align-items:center;width:88%;margin:4px 0 12px;padding:8px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#111827;text-decoration:none}",
    ".guide:hover{border-color:var(--p)}",
    ".guide img{width:80px;height:56px;flex:none;object-fit:cover;object-position:top;border:1px solid #e5e7eb;border-radius:6px}",
    ".guide b{display:block;font-weight:600;line-height:1.3}.guide small{display:block;margin-top:2px;font-size:12px;color:#4b5563}.guide small span{color:var(--pt);white-space:nowrap}",
    ".guide b .n{margin-right:4px;color:var(--pt)}",
    ".cites{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 12px;font-size:12px;color:#4b5563}",
    ".cites a{display:inline-block;border:1px solid #e5e7eb;border-radius:999px;padding:3px 10px;color:#374151;text-decoration:none}",
    ".cites a:hover{border-color:var(--p);color:var(--pt)}",
    "form.ask{display:flex;gap:8px;align-items:center;padding:10px;border-top:1px solid #eef0f3;background:#fafbfc}",
    "input{flex:1;min-width:0;border:1px solid #d1d5db;border-radius:999px;padding:8px 14px;outline:none;background:#fff;color:#111827}",
    "input:focus{border-color:var(--p);box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 20%,transparent)}",
    ".send{width:36px;height:36px;border:0;border-radius:999px;background:var(--p);color:var(--pf);cursor:pointer;display:grid;place-items:center;flex:none}",
    ".toggle{display:inline-flex;align-items:center;gap:8px;border:0;background:var(--p);color:var(--pf);border-radius:999px;padding:10px 16px 10px 12px;cursor:pointer;font-weight:600;box-shadow:0 8px 24px -6px rgba(15,23,42,.35)}",
    ".toggle.hidden{display:none}",
    // Visible `:focus-visible` on every interactive element (several set `outline:none` above
    // and replace it themselves). `--pt`, not raw `--p`: the ring is drawn on this panel's own
    // white background, so it needs >= 3:1 against white, which `--p` alone isn't guaranteed to
    // clear.
    ".x:focus-visible,.send:focus-visible,.toggle:focus-visible,.guide:focus-visible,.cites a:focus-visible,.tab:focus-visible,.row a:focus-visible,.show-me:focus-visible{outline:2px solid var(--pt);outline-offset:2px}",
    "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:1ms!important;transition-duration:1ms!important;scroll-behavior:auto!important}}",
  ].join("\n");
  shadow.appendChild(style);

  // `aria-hidden` + `focusable="false"`: every icon is decorative — the button/link around it
  // already carries the accessible name (aria-label or text). Static strings, never fetched data.
  var ICON_HELP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
  var ICON_SEND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';
  var ICON_NEW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  var ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  var PANEL_ID = "aida-help-panel";
  var root = el("div", { class: "dg" });
  // A non-modal region, not a modal dialog: the app stays usable beside it for every reader (a
  // mouse user can always click the app, so a focus trap would only lock keyboard and
  // screen-reader users in). Tab leaves it like any other part of the page; Escape still closes
  // it and returns focus to the launcher. Same in the chat view: answers and errors reach a
  // screen reader through the live region and `role="alert"`, which need no trap.
  var panel = el("div", { class: "panel", id: PANEL_ID, role: "region", "aria-label": "Help" });
  var mark = el("span", { class: "mark" });
  mark.innerHTML = ICON_HELP;
  var titleEl = el("div", { class: "title" }, ["Help"]);
  var subEl = el("div", { class: "sub" }, ["Guides for the screen you're on"]);
  var header = el("div", { class: "head" }, [mark, el("div", { class: "grow" }, [titleEl, subEl])]);
  var newBtn = el("button", { class: "x new", type: "button", "aria-label": "Start a new chat", title: "New chat" });
  newBtn.innerHTML = ICON_NEW;
  header.appendChild(newBtn);
  var closeBtn = el("button", { class: "x", type: "button", "aria-label": "Close help" });
  closeBtn.innerHTML = ICON_X;
  header.appendChild(closeBtn);

  // Tabs only appear once chat is known to work; until then the guides view is the whole panel.
  var GUIDES_ID = "aida-help-guides";
  var CHAT_ID = "aida-help-chat";
  var tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Help sections" });
  var tabGuides = el("button", { class: "tab", type: "button", role: "tab", id: GUIDES_ID + "-tab", "aria-controls": GUIDES_ID }, ["Guides"]);
  var tabChat = el("button", { class: "tab", type: "button", role: "tab", id: CHAT_ID + "-tab", "aria-controls": CHAT_ID }, ["Ask"]);
  tabs.appendChild(tabGuides);
  tabs.appendChild(tabChat);
  tabs.hidden = true;

  // Guides: search plus "Help for this screen" (or results).
  var guidesView = el("div", { class: "view", id: GUIDES_ID });
  var findForm = el("form", { class: "find", role: "search" });
  var searchInput = el("input", { type: "search", placeholder: "Search all guides…", "aria-label": "Search all guides", autocomplete: "off" });
  findForm.appendChild(searchInput);
  var list = el("div", { class: "list" });
  var listHeading = el("h2", {}, ["Help for this screen"]);
  var rows = el("ul", { class: "rows" });
  var none = el("div", { class: "none" });
  list.appendChild(listHeading);
  list.appendChild(rows);
  list.appendChild(none);
  guidesView.appendChild(findForm);
  guidesView.appendChild(list);

  // Chat.
  var chatView = el("div", { class: "view", id: CHAT_ID, role: "tabpanel", "aria-labelledby": CHAT_ID + "-tab" });
  chatView.hidden = true;
  var messages = el("div", { class: "msgs" });
  var empty = el("div", { class: "empty" }, [
    el("b", {}, ["Ask a question"]),
    el("div", { style: "font-size:12px;max-width:16rem" }, ["You'll get a short answer and a link to the guide."]),
  ]);
  messages.appendChild(empty);
  var form = el("form", { class: "ask" });
  var input = el("input", { placeholder: "Ask a question…", "aria-label": "Ask the help chat" });
  var sendBtn = el("button", { type: "submit", class: "send", "aria-label": "Send" });
  sendBtn.innerHTML = ICON_SEND;
  form.appendChild(input);
  form.appendChild(sendBtn);
  chatView.appendChild(messages);
  chatView.appendChild(form);

  // Announces result counts, finished answers and errors without moving focus — a
  // visually-hidden live region, same pattern as the React ChatWidget.
  var live = el("div", { class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });

  panel.appendChild(header);
  panel.appendChild(tabs);
  panel.appendChild(guidesView);
  panel.appendChild(chatView);
  panel.appendChild(live);

  var toggle = el("button", { type: "button", class: "toggle", "aria-expanded": "false", "aria-controls": PANEL_ID });
  toggle.innerHTML = ICON_HELP;
  toggle.appendChild(document.createTextNode("Help"));

  root.appendChild(panel);
  root.appendChild(toggle);
  shadow.appendChild(root);
  document.body.appendChild(host);

  // The help site's brand (written by the aida engine): colour, name, logo and font, so the
  // widget looks like part of the app rather than a third-party bolt-on.
  fetch(helpUrl + "/brand/theme.json", { referrerPolicy: "no-referrer" })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (t) {
      if (!t) return;
      if (typeof t.primary === "string") root.style.setProperty("--p", t.primary);
      if (typeof t.primaryForeground === "string") root.style.setProperty("--pf", t.primaryForeground);
      if (typeof t.primaryText === "string") root.style.setProperty("--pt", t.primaryText);
      if (typeof t.fontFamily === "string") root.style.setProperty("--font", t.fontFamily);
      if (typeof t.name === "string" && t.name) {
        titleEl.textContent = t.name + " help";
        panel.setAttribute("aria-label", t.name + " help");
      }
      var logo = sitePath(t.logo);
      if (logo) {
        mark.style.background = "#fff";
        mark.textContent = "";
        mark.appendChild(el("img", { src: helpUrl + logo, alt: "" }));
      }
    })
    .catch(noop);

  // ---- State kept across page loads of the app (sessionStorage: clears when the tab closes) ----

  var STORAGE_KEY = "aida-help-chat";
  var turns = [];
  var isOpen = false;
  var view = "guides";
  // The reader was in chat on the last page: back to it once the help site says chat works.
  var pendingChat = false;
  var chatAvailable = false;
  var touring = false;

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open: isOpen, turns: turns, view: pendingChat ? "chat" : view }));
    } catch (e) {}
  }

  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) return;
      if (typeof saved !== "object") return;
      var kept = (Array.isArray(saved.turns) ? saved.turns : []).map(cleanTurn).filter(Boolean);
      while (kept.length && kept[kept.length - 1].role === "user") kept.pop();
      turns = kept;
      isOpen = !!saved.open;
      pendingChat = saved.view === "chat";
    } catch (e) {}
  }

  var announceTimer = 0;
  /** Waits for typing to settle, so a screen reader hears the final count, not every keystroke's. */
  function announce(text, now) {
    clearTimeout(announceTimer);
    if (now) {
      live.textContent = text;
      return;
    }
    announceTimer = setTimeout(function () {
      live.textContent = text;
    }, 500);
  }

  // ---- Guides: help-map.json and search-index.json from the help site ----

  var guides = [];
  var mapState = "idle"; // idle | loading | ready | failed
  var mapPromise = null;

  function cleanGuide(g) {
    if (!g || typeof g.id !== "string" || typeof g.title !== "string") return null;
    var url = sitePath(g.url);
    if (!url) return null;
    var screens = Array.isArray(g.screens)
      ? g.screens.filter(function (s) {
          return typeof s === "string";
        })
      : [];
    return {
      id: g.id,
      title: g.title,
      url: url,
      steps: typeof g.steps === "number" && g.steps > 0 ? Math.floor(g.steps) : 0,
      summary: typeof g.summary === "string" ? g.summary : "",
      starts: typeof g.starts === "string" ? g.starts : null,
      screens: screens,
      tour: g.tour === true,
    };
  }

  function loadMap() {
    if (mapPromise) return mapPromise;
    mapState = "loading";
    mapPromise = fetch(helpUrl + "/help-map.json", { referrerPolicy: "no-referrer" })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then(function (m) {
        guides = (m && Array.isArray(m.guides) ? m.guides : []).map(cleanGuide).filter(Boolean);
        mapState = "ready";
      })
      .catch(function () {
        mapState = "failed";
      })
      .then(function () {
        renderGuides();
      });
    return mapPromise;
  }

  /** Guides that start on this screen first, then guides that pass through it. */
  function guidesForPath(path) {
    var starting = [];
    var passing = [];
    guides.forEach(function (g) {
      if (g.starts && matchRoutePattern(g.starts, path)) starting.push(g);
      else if (
        g.screens.some(function (s) {
          return matchRoutePattern(s, path);
        })
      )
        passing.push(g);
    });
    return starting.concat(passing);
  }

  function guideByUrl(url) {
    var page = url.split("#")[0].replace(/\/+$/, "") || "/";
    return guides.filter(function (g) {
      return g.url === page;
    })[0];
  }

  var searchIndex = null;
  var indexState = "idle"; // idle | loading | ready | failed
  var indexPromise = null;

  function loadIndex() {
    if (indexPromise) return indexPromise;
    indexState = "loading";
    indexPromise = fetch(helpUrl + "/search-index.json", { referrerPolicy: "no-referrer" })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then(function (data) {
        searchIndex = (Array.isArray(data) ? data : []).filter(function (e) {
          return e && typeof e.title === "string" && typeof e.text === "string" && sitePath(e.url);
        });
        indexState = "ready";
      })
      .catch(function () {
        indexState = "failed";
      })
      .then(function () {
        renderGuides();
      });
    return indexPromise;
  }

  // <search-rank> Scored exactly like the help site's own search (components/site/search-dialog.tsx
  // `rank`, `cleanText`, `excerpt`); a test feeds both the same index and queries.
  // Every query word must appear; titles and headings count for more than body text.
  function rank(index, query) {
    var words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    var hits = [];
    index.forEach(function (entry) {
      var title = entry.title.toLowerCase();
      var heading = typeof entry.heading === "string" ? entry.heading.toLowerCase() : "";
      var text = entry.text.toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var s = (title.indexOf(w) >= 0 ? 6 : 0) + (heading.indexOf(w) >= 0 ? 4 : 0) + (text.indexOf(w) >= 0 ? 1 : 0);
        if (s === 0) return;
        score += s;
      }
      if (title.indexOf(words[0]) === 0) score += 3;
      // A whole guide beats one of its own sections when both match.
      if (!entry.heading) score += 8;
      hits.push({ entry: entry, score: score });
    });
    // At most three results per guide, so one long page can't fill the list. A stable sort, as
    // Array.prototype.sort is in every current browser and in Node.
    var perPage = {};
    return hits
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .filter(function (h) {
        var page = h.entry.url.split("#")[0];
        var n = perPage[page] || 0;
        perPage[page] = n + 1;
        return n < 3;
      })
      .slice(0, 12);
  }

  function cleanText(text) {
    return text
      .replace(/\{\/?\*?[\s\S]*?\*?\/?\}/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/[*_`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function excerpt(text, query) {
    var clean = cleanText(text);
    var first = query.toLowerCase().split(/\s+/).filter(Boolean)[0] || "";
    var at = first ? clean.toLowerCase().indexOf(first) : -1;
    var start = Math.max(0, at - 40);
    var snippet = clean.slice(start, start + 140);
    return (start > 0 ? "…" : "") + snippet + (start + 140 < clean.length ? "…" : "");
  }
  // </search-rank>

  // ---- Searches that find nothing go to the owner's feedback inbox, once per query ----
  // The same rules as the help site's own recorder (components/site/search-feedback.ts and
  // feedback-client.ts): a query counts once the reader pauses on it (or presses Enter, or closes
  // the panel with it showing), at least three characters, once per normalised query per
  // session. Fields stay under the route's caps (feedback/entry.ts FEEDBACK_LIMITS), which
  // answers 400 rather than clipping.

  var REPORTED_KEY = "aida-help-no-results";
  var SEARCH_MIN_CHARS = 3;
  var SEARCH_PAUSE_MS = 1500;
  var QUERY_MAX = 120;
  var PATH_MAX = 300;
  // No prototype, so a query such as "constructor" or "toString" isn't already "reported".
  var reported = Object.create(null);
  try {
    var savedReported = JSON.parse(sessionStorage.getItem(REPORTED_KEY) || "null");
    if (savedReported && typeof savedReported === "object" && !Array.isArray(savedReported)) {
      Object.keys(savedReported).forEach(function (k) {
        if (savedReported[k] === true) reported[k] = true;
      });
    }
  } catch (e) {}
  var reportTimer = 0;
  var pendingReport = null;

  /** feedback-client.ts `searchKey`: case, punctuation and spacing don't make two searches. */
  function searchKey(q) {
    return q
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cancelReport() {
    clearTimeout(reportTimer);
    reportTimer = 0;
    pendingReport = null;
  }

  /** A search with no results: report it once the reader pauses on it. */
  function scheduleReport(q) {
    cancelReport();
    var trimmed = q.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) return;
    var key = searchKey(trimmed);
    if (!key || reported[key]) return;
    pendingReport = { query: trimmed.slice(0, QUERY_MAX), key: key };
    reportTimer = setTimeout(flushReport, SEARCH_PAUSE_MS);
  }

  /** Report the pending search now (Enter, or the panel closing). */
  function flushReport() {
    var pending = pendingReport;
    cancelReport();
    if (!pending || reported[pending.key]) return;
    reported[pending.key] = true;
    try {
      sessionStorage.setItem(REPORTED_KEY, JSON.stringify(reported));
    } catch (e) {}
    // Fire and forget: a missing route, a static host or a CORS refusal is never the reader's
    // problem, so no retry and nothing shown.
    var body = { kind: "no-results", query: pending.query };
    var here = appPath();
    if (here) body.currentPath = here.slice(0, PATH_MAX);
    try {
      fetch(helpUrl + "/api/feedback", {
        method: "POST",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(noop);
    } catch (e) {}
  }

  // ---- Rendering the guides view ----

  function stepsLabel(n) {
    return n === 1 ? "1 step" : n + " steps";
  }

  function guideLink(text, path, extra) {
    var a = el("a", { href: helpUrl + path, target: "_blank", rel: "noopener noreferrer" }, [text]);
    if (extra) a.appendChild(el("span", { class: "sr-only" }, [extra]));
    a.appendChild(el("span", { class: "sr-only" }, [" (opens in a new tab)"]));
    return a;
  }

  function showMeButton(guide) {
    var b = el("button", { type: "button", class: "show-me", "aria-label": "Show me how: " + guide.title }, ["Show me"]);
    b.addEventListener("click", function () {
      startTour(guide);
    });
    return b;
  }

  function guideRow(g) {
    var main = el("div", { class: "grow" }, [guideLink(g.title, g.url), el("span", { class: "meta" }, [g.steps ? stepsLabel(g.steps) : "Guide"])]);
    if (g.summary) main.appendChild(el("span", { class: "sum" }, [g.summary]));
    var li = el("li", { class: "row" }, [main]);
    if (g.tour) li.appendChild(showMeButton(g));
    return li;
  }

  function resultRow(hit, query) {
    var e = hit.entry;
    var main = el("div", { class: "grow" });
    main.appendChild(guideLink(e.title, sitePath(e.url), typeof e.heading === "string" && e.heading ? " · " + e.heading : ""));
    var meta = [];
    if (typeof e.heading === "string" && e.heading) meta.push(e.heading);
    if (typeof e.section === "string" && e.section) meta.push(e.section);
    if (meta.length) main.appendChild(el("span", { class: "meta", "aria-hidden": "true" }, [meta.join(" · ")]));
    var text = excerpt(e.text, query);
    if (text) main.appendChild(el("span", { class: "sum" }, [text]));
    var li = el("li", { class: "row" }, [main]);
    var g = guideByUrl(e.url);
    if (g && g.tour && !e.heading) li.appendChild(showMeButton(g));
    return li;
  }

  function setNone(title, text) {
    none.textContent = "";
    none.hidden = false;
    none.appendChild(el("b", {}, [title]));
    if (text) none.appendChild(el("span", {}, [text]));
  }

  function renderGuides() {
    if (!isOpen || view !== "guides") return;
    var q = searchInput.value.trim();
    rows.textContent = "";
    none.hidden = true;
    cancelReport();

    if (q.length >= 2) {
      listHeading.textContent = "Search results";
      if (indexState !== "ready") {
        if (indexState === "failed") setNone("Search isn't available right now.", "");
        else {
          setNone("Searching…", "");
          void loadIndex();
        }
        return;
      }
      // The guides list tells a result's tour apart; search works without it.
      if (mapState === "idle") void loadMap();
      var hits = rank(searchIndex, q);
      hits.forEach(function (h) {
        rows.appendChild(resultRow(h, q));
      });
      if (!hits.length) {
        setNone("No guides match “" + q + "”.", "Try fewer or different words.");
        announce("No guides match.");
        // Waits for the reader to stop typing; Enter sends it straight away.
        scheduleReport(q);
      } else announce(hits.length === 1 ? "1 result." : hits.length + " results.");
      return;
    }

    listHeading.textContent = "Help for this screen";
    if (mapState === "idle" || mapState === "loading") {
      setNone("Loading guides…", "");
      void loadMap();
      return;
    }
    var path = appPath();
    var here = mapState === "ready" && path !== null ? guidesForPath(path) : [];
    here.forEach(function (g) {
      rows.appendChild(guideRow(g));
    });
    if (!here.length) {
      setNone("No guides for this screen yet.", "Search all guides above.");
      announce("No guides for this screen. Search all guides above.");
    } else announce(here.length === 1 ? "1 guide for this screen." : here.length + " guides for this screen.");
  }

  searchInput.addEventListener("input", function () {
    if (searchInput.value.trim().length >= 2 && indexState === "idle") void loadIndex();
    renderGuides();
  });
  findForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    if (q.length >= 2 && indexState === "ready" && !rank(searchIndex, q).length) {
      scheduleReport(q);
      flushReport();
    }
  });

  // ---- "Show me": the in-app tour (public/tour.js), loaded only when wanted ----

  var tourScript = null;
  var tourWaiters = [];

  function tourReady() {
    return window.AidaTour && typeof window.AidaTour.start === "function";
  }

  function loadTour(done) {
    if (tourReady()) {
      if (done) done();
      return;
    }
    if (done) tourWaiters.push(done);
    if (tourScript) return;
    tourScript = document.createElement("script");
    tourScript.src = helpUrl + "/tour.js";
    tourScript.setAttribute("data-help-url", helpUrl);
    if (basePath) tourScript.setAttribute("data-base-path", basePath);
    // The app's address (query tokens and all) stays out of the help site's logs.
    tourScript.referrerPolicy = "no-referrer";
    tourScript.async = true;
    tourScript.onload = function () {
      tourWaiters.splice(0).forEach(function (f) {
        f();
      });
    };
    tourScript.onerror = function () {
      if (tourScript && tourScript.parentNode) tourScript.parentNode.removeChild(tourScript);
      tourScript = null;
      tourWaiters.splice(0).forEach(function (f) {
        f(new Error("tour.js failed to load"));
      });
    };
    (document.head || document.body).appendChild(tourScript);
  }

  function startTour(guide) {
    loadTour(function (err) {
      try {
        if (err || !tourReady()) throw err || new Error("no tour");
        var opts = { id: guide.id, helpUrl: helpUrl };
        if (basePath) opts.basePath = basePath;
        window.AidaTour.start(opts);
      } catch (e) {
        announce("The tour couldn't start. Open the guide instead.", true);
      }
    });
  }

  window.addEventListener("aida-tour", function (e) {
    var type = e && e.detail && e.detail.type;
    if (type === "started" || type === "step") {
      touring = true;
      if (type === "started" && isOpen) setOpen(false, true);
    } else if (type === "finished" || type === "stopped") {
      touring = false;
    } else return;
    syncToggle();
  });

  /** A tour that crashed after "started" never sends "finished" or "stopped", which would leave
   * the launcher hidden for good. So whenever the reader next acts or the app navigates, ask
   * tour.js itself (`active()`), and bring the launcher back if no tour is running. Costs
   * nothing while no tour is. */
  function checkTour() {
    if (!touring) return;
    var tour = window.AidaTour;
    var running = true;
    if (!tour) running = false;
    else if (typeof tour.active === "function") {
      try {
        running = !!tour.active();
      } catch (e) {
        running = false;
      }
    }
    if (running) return;
    touring = false;
    syncToggle();
  }
  // Capture phase and passive: the app's own handlers can't hide these and aren't slowed.
  window.addEventListener("pointerdown", checkTour, { capture: true, passive: true });
  window.addEventListener("keydown", checkTour, { capture: true, passive: true });

  // ---- Chat (only once the help site says it works) ----

  var chatChecked = false;

  function checkChat() {
    if (chatChecked) return;
    chatChecked = true;
    fetch(helpUrl + "/api/chat", { method: "GET", headers: { Accept: "application/json" }, cache: "no-store", referrerPolicy: "no-referrer" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (status) {
        if (!status || status.available !== true) return;
        chatAvailable = true;
        tabs.hidden = false;
        guidesView.setAttribute("role", "tabpanel");
        guidesView.setAttribute("aria-labelledby", GUIDES_ID + "-tab");
        if (pendingChat && view !== "chat") {
          pendingChat = false;
          // Focus follows only if it was still where opening the panel put it.
          showView("chat", isOpen && shadow.activeElement === searchInput);
        } else syncTabs();
      })
      .catch(noop)
      .then(function () {
        if (pendingChat) {
          pendingChat = false;
          save();
        }
      });
  }

  function syncTabs() {
    [
      [tabGuides, view === "guides"],
      [tabChat, view === "chat"],
    ].forEach(function (pair) {
      pair[0].setAttribute("aria-selected", String(pair[1]));
      pair[0].setAttribute("tabindex", pair[1] ? "0" : "-1");
    });
  }

  function showView(next, focus) {
    if (next === "chat" && !chatAvailable) next = "guides";
    view = next;
    guidesView.hidden = next !== "guides";
    chatView.hidden = next !== "chat";
    subEl.textContent = next === "chat" ? "Answers come from the help guides" : "Guides for the screen you're on";
    syncTabs();
    renderAll();
    if (next === "guides") renderGuides();
    if (focus) (next === "chat" ? input : searchInput).focus();
    save();
  }

  tabGuides.addEventListener("click", function () {
    pendingChat = false;
    showView("guides", false);
  });
  tabChat.addEventListener("click", function () {
    showView("chat", false);
  });
  tabs.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    var next = e.key === "Home" ? "guides" : e.key === "End" ? "chat" : view === "guides" ? "chat" : "guides";
    showView(next, false);
    (next === "chat" ? tabChat : tabGuides).focus();
  });

  /** Completed question/answer pairs only, so the history always alternates. */
  function historyFromTurns() {
    var out = [];
    for (var i = 0; i + 1 < turns.length; i++) {
      var q = turns[i];
      var a = turns[i + 1];
      if (q.role === "user" && a.role === "assistant" && a.done && a.text && !a.error) {
        out.push({ role: "user", content: q.text }, { role: "assistant", content: a.text });
        i++;
      }
    }
    return out;
  }

  // Light Markdown, matching components/chat/markdown.tsx: paragraphs, lists, **bold**,
  // *italic*, `code` and [n] citations. Built as DOM nodes, never innerHTML, so model output
  // can't inject markup.
  var ORDERED = /^\s*\d+[.)]\s+/;
  var UNORDERED = /^\s*[-*•]\s+/;
  var INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[\d+\])/g;

  function parseBlocks(text) {
    var blocks = [];
    text.split("\n").forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      var last = blocks[blocks.length - 1];
      if (!line.trim()) {
        blocks.push({ kind: "p", lines: [] });
        return;
      }
      var kind = ORDERED.test(line) ? "ol" : UNORDERED.test(line) ? "ul" : null;
      if (kind) {
        var item = line.replace(kind === "ol" ? ORDERED : UNORDERED, "");
        if (last && last.kind === kind) last.items.push(item);
        else blocks.push({ kind: kind, items: [item] });
      } else if (last && last.kind !== "p" && /^\s{2,}/.test(raw)) {
        last.items[last.items.length - 1] += " " + line.trim();
      } else if (last && last.kind === "p") {
        last.lines.push(line);
      } else {
        blocks.push({ kind: "p", lines: [line] });
      }
    });
    return blocks.filter(function (b) {
      return b.kind === "p" ? b.lines.length : b.items.length;
    });
  }

  function appendInline(parent, text, citations) {
    text.split(INLINE).forEach(function (part) {
      if (!part) return;
      var m = /^\[(\d+)\]$/.exec(part);
      if (part.charAt(0) === "`") parent.appendChild(el("code", {}, [part.slice(1, -1)]));
      else if (part.slice(0, 2) === "**" || part.slice(0, 2) === "__") parent.appendChild(el("strong", {}, [part.slice(2, -2)]));
      else if (/^[*_]/.test(part)) parent.appendChild(el("em", {}, [part.slice(1, -1)]));
      else if (m) {
        var c = (citations || []).filter(function (x) {
          return x.n === Number(m[1]);
        })[0];
        if (c) parent.appendChild(el("a", { class: "cite", href: helpUrl + c.url, target: "_blank", rel: "noreferrer", title: c.title }, [String(c.n)]));
      } else parent.appendChild(document.createTextNode(part));
    });
  }

  function renderMarkdown(node, text, citations) {
    node.textContent = "";
    parseBlocks(text).forEach(function (block) {
      if (block.kind === "p") {
        var p = el("p", {});
        block.lines.forEach(function (line, j) {
          if (j > 0) p.appendChild(el("br", {}));
          appendInline(p, line, citations);
        });
        node.appendChild(p);
      } else {
        var listEl = el(block.kind, {});
        block.items.forEach(function (item) {
          var li = el("li", {});
          appendInline(li, item, citations);
          listEl.appendChild(li);
        });
        node.appendChild(listEl);
      }
    });
  }

  function citedNumbers(text) {
    var nums = {};
    (text.match(/\[\d+\]/g) || []).forEach(function (m) {
      nums[Number(m.slice(1, -1))] = true;
    });
    return nums;
  }

  /** Under a finished answer: only the guides it cited, in citation order — a walkthrough as a
   * card, any other page as a link. */
  function renderSources(turn) {
    if (!turn.done || !turn.citations) return;
    var cited = citedNumbers(turn.text || "");
    var sources = turn.citations.filter(function (c) {
      return cited[c.n];
    });
    function procedureFor(c) {
      return (turn.procedures || []).filter(function (p) {
        return p.url === c.url;
      })[0];
    }
    var cards = sources.filter(procedureFor);
    cards.forEach(function (c) {
      var proc = procedureFor(c);
      var card = el("a", { class: "guide", href: helpUrl + c.url, target: "_blank", rel: "noreferrer" });
      if (proc.firstScreenshot) card.appendChild(el("img", { src: helpUrl + proc.firstScreenshot, alt: "" }));
      var meta = (proc.stepCount ? proc.stepCount + " steps" : "Guide") + (proc.firstVideoTimeSec !== undefined ? " · with video" : "") + " · ";
      var name = el("b", {}, cards.length > 1 ? [el("span", { class: "n" }, [String(c.n)]), c.title] : [c.title]);
      card.appendChild(el("div", {}, [name, el("small", {}, [meta, el("span", {}, ["Open guide →"])])]));
      messages.appendChild(card);
    });
    var others = sources.filter(function (c) {
      return !procedureFor(c);
    });
    if (!others.length) return;
    var row = el("div", { class: "cites" }, [cards.length ? "Also see" : "From"]);
    others.forEach(function (c) {
      row.appendChild(el("a", { href: helpUrl + c.url, target: "_blank", rel: "noreferrer" }, [c.title]));
    });
    messages.appendChild(row);
  }

  function addBubble(role) {
    if (empty.parentNode) empty.parentNode.removeChild(empty);
    var bubble = el("div", { class: "b " + role });
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function fillAssistant(bubble, turn, isCurrent) {
    if (turn.text) {
      bubble.removeAttribute("role");
      bubble.removeAttribute("aria-label");
      renderMarkdown(bubble, turn.text, turn.citations);
    } else if (!turn.done) {
      bubble.setAttribute("role", "status");
      bubble.setAttribute("aria-label", "Thinking");
      bubble.textContent = "…";
    } else {
      bubble.removeAttribute("role");
      bubble.removeAttribute("aria-label");
      bubble.textContent = "";
    }
    // `renderAll` rebuilds every past turn on each render — `role="alert"` only on the current
    // turn's error, so an older error already announced once doesn't get re-announced every time
    // a new question re-renders the whole list.
    if (turn.error) bubble.appendChild(el("div", isCurrent ? { class: "err", role: "alert" } : { class: "err" }, [turn.error]));
  }

  function renderAll() {
    messages.textContent = "";
    if (!turns.length) messages.appendChild(empty);
    turns.forEach(function (turn, i) {
      var bubble = addBubble(turn.role);
      if (turn.role === "user") bubble.textContent = turn.text;
      else {
        fillAssistant(bubble, turn, i === turns.length - 1);
        renderSources(turn);
      }
    });
    newBtn.classList.toggle("show", view === "chat" && turns.length > 0 && !busy);
    messages.scrollTop = messages.scrollHeight;
  }

  // ---- Open, close, focus ----

  function syncToggle() {
    // Out of the tour's way until it finishes or stops.
    toggle.classList.toggle("hidden", isOpen || touring);
  }

  var pollTimer = 0;

  /** `focus`: the reader opened the panel, so focus goes into it. A panel restored open on page
   * load leaves focus where the app put it (its own search box, a form field). */
  function setOpen(open, quiet, focus) {
    var wasOpen = isOpen;
    isOpen = open;
    panel.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    syncToggle();
    if (open) {
      checkChat();
      lastPath = location.pathname;
      watchPath(true);
      showView(view, !!focus);
      // Return focus to the toggle whenever the panel closes (Escape, the close button, or
      // programmatically) — WCAG 2.2 AA focus management. Not when a tour took over: the toggle
      // is hidden then and the tour owns focus.
    } else {
      watchPath(false);
      // A search left showing with no results counts now, as the site's dialog does on close.
      flushReport();
      if (wasOpen && !quiet && !touring) toggle.focus();
    }
    save();
  }

  toggle.addEventListener("click", function () {
    setOpen(true, false, true);
  });
  closeBtn.addEventListener("click", function () {
    setOpen(false);
  });
  newBtn.addEventListener("click", function () {
    turns = [];
    live.textContent = "";
    save();
    renderAll();
    input.focus();
  });

  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      // The first Escape in a search with text clears it, the next closes the panel.
      if (e.target === searchInput && searchInput.value) {
        e.preventDefault();
        searchInput.value = "";
        renderGuides();
        return;
      }
      setOpen(false);
    }
    // No focus trap: the panel is non-modal (see where it's created), so Tab moves on into the
    // rest of the page.
  });

  // ---- Following the app's own navigation, without patching it ----

  var lastPath = location.pathname;
  var hasNavigationApi = !!(window.navigation && typeof window.navigation.addEventListener === "function");

  function onLocation() {
    checkTour();
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (isOpen && view === "guides" && searchInput.value.trim().length < 2) renderGuides();
  }

  if (hasNavigationApi) {
    window.navigation.addEventListener("currententrychange", function () {
      setTimeout(onLocation, 0);
    });
  }
  window.addEventListener("popstate", onLocation);

  /** Without the Navigation API, a light pathname poll — only while the panel is open, since a
   * closed panel re-reads the path when it opens. */
  function watchPath(on) {
    clearInterval(pollTimer);
    pollTimer = 0;
    if (on && !hasNavigationApi) pollTimer = setInterval(onLocation, 400);
  }

  // ---- Asking ----

  async function ask(question) {
    if (!question.trim() || busy) return;
    busy = true;
    var history = historyFromTurns();
    var turn = { role: "assistant", text: "" };
    turns.push({ role: "user", text: question }, turn);
    live.textContent = "";
    renderAll();
    var bubbles = messages.querySelectorAll(".b.assistant");
    var answerBubble = bubbles[bubbles.length - 1];

    try {
      var res = await fetch(helpUrl + "/api/chat", {
        method: "POST",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, currentPath: appPath() || undefined, history: history }),
      });

      if (!res.ok || !res.body) {
        var errBody = await res.json().catch(function () {
          return { error: "request failed (" + res.status + ")" };
        });
        turn.error = errBody.error || "something went wrong";
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";

      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          var line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          var event = JSON.parse(line);
          if (event.type === "meta") {
            turn.citations = cleanCitations(event.citations);
            turn.procedures = cleanProcedures(event.procedures);
          } else if (event.type === "delta" && typeof event.text === "string") {
            turn.text += event.text;
            fillAssistant(answerBubble, turn);
            messages.scrollTop = messages.scrollHeight;
          } else if (event.type === "error") {
            turn.error = typeof event.message === "string" ? event.message : "something went wrong";
          }
        }
      }
    } catch (err) {
      turn.error = "couldn't reach help chat";
    } finally {
      turn.done = true;
      busy = false;
      // Announces once the answer finishes, not every streamed delta; an error gets its own
      // role="alert" instead (fillAssistant), so it isn't also read out here.
      live.textContent = turn.error ? "" : "Answer ready.";
      save();
      renderAll();
    }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = "";
    void ask(q);
  });

  // ---- Start ----

  load();
  syncTabs();
  renderAll();
  // A tour in progress (set by tour.js, or a link with ?aida-tour=) resumes by itself once loaded.
  var resumeTour = false;
  try {
    resumeTour = !!sessionStorage.getItem("aida-tour");
  } catch (e) {}
  try {
    if (!resumeTour) resumeTour = new URLSearchParams(location.search).has("aida-tour");
  } catch (e) {}
  if (resumeTour) loadTour();
  if (isOpen) setOpen(true);
})();
