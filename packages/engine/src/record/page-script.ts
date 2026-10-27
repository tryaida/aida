// The browser side of `aida record`: a small toolbar plus event listeners, installed with
// `context.addInitScript` (so it comes back on every page load) and `page.evaluate` (for the page
// already open). Plain source text, not a function, for the reason capture/init-scripts.ts gives.
//
// It sends what the person does to Node through the `__aidaRecord` binding (session.ts), with a
// `data-aida-rec` marker on each element so Node can find it again and work out a target with
// the same `locate()` capture uses. Hovering an element sends it ahead of the click, so Node has
// usually checked the target before a click navigates away.
//
// Only the top frame records. The toolbar lives in a closed shadow root and its own events never
// reach the recorder or the app. While picking ("Point at", "Check shown") the next click is
// swallowed: it names an element, it doesn't press it. `window.__aidaRecorderTool(name, value)`
// does what the toolbar's buttons do, for a script.
export const RECORDER_SCRIPT = `
(function () {
  if (window.top !== window) return;
  if (window.__aidaRecorderInstalled) return;
  window.__aidaRecorderInstalled = true;

  var prefix = Math.random().toString(36).slice(2, 7);
  var counter = 0;
  var host = null;
  var ui = {};
  var mode = null;
  var hovered = null;
  var hoverTimer = null;
  var lastClickAt = 0;

  function send(msg) {
    try {
      if (typeof window.__aidaRecord !== "function") return Promise.resolve(null);
      return Promise.resolve(window.__aidaRecord(msg)).then(function (status) {
        if (status) showStatus(status);
        return status;
      }, function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function inToolbar(ev) {
    if (!host) return false;
    var path = ev.composedPath ? ev.composedPath() : [];
    for (var i = 0; i < path.length; i++) if (path[i] === host) return true;
    return false;
  }

  function clean(text, cap) {
    if (!text) return "";
    var t = String(text).replace(/\\s+/g, " ").trim();
    return t.length > (cap || 80) ? "" : t;
  }

  function mark(el) {
    var m = el.getAttribute("data-aida-rec");
    if (!m) {
      m = prefix + "-" + (++counter);
      el.setAttribute("data-aida-rec", m);
    }
    return m;
  }

  var INTERACTIVE = "a[href],button,input,select,textarea,summary,[contenteditable=''],[contenteditable='true']," +
    "[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab]," +
    "[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[role=gridcell]," +
    "[role=textbox],[role=searchbox],[role=slider],[role=spinbutton]";

  function interactive(el) {
    var found = el && el.closest ? el.closest(INTERACTIVE) : null;
    return found || el;
  }

  function implicitRole(el) {
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
      if (type === "hidden" || type === "file") return undefined;
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
    if (tag === "section" && (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"))) return "region";
    if (el.isContentEditable) return "textbox";
    return undefined;
  }

  function labelFor(el) {
    if (el.labels && el.labels.length) return el.labels[0];
    var wrap = el.closest ? el.closest("label") : null;
    return wrap || null;
  }

  function labelTexts(label) {
    var direct = "";
    label.childNodes.forEach(function (n) { if (n.nodeType === 3) direct += (n.textContent || "") + " "; });
    var clone = label.cloneNode(true);
    clone.querySelectorAll("select, input, textarea, [role]").forEach(function (c) { c.remove(); });
    return { direct: clean(direct), full: clean(clone.textContent || "") };
  }

  function byIds(ids) {
    return ids.split(/\\s+/).map(function (id) {
      var e = document.getElementById(id);
      return e ? e.textContent || "" : "";
    }).join(" ");
  }

  function nameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    var by = el.getAttribute("aria-labelledby");
    if (by) return clean(byIds(by));
    var label = labelFor(el);
    if (label) {
      var t = labelTexts(label);
      if (t.full) return t.full;
    }
    if (el.tagName === "IMG" && el.getAttribute("alt")) return clean(el.getAttribute("alt"));
    if (el.tagName === "INPUT") {
      var type = (el.getAttribute("type") || "").toLowerCase();
      if ((type === "submit" || type === "button" || type === "reset") && el.value) return clean(el.value);
      if (el.getAttribute("placeholder")) return clean(el.getAttribute("placeholder"));
    }
    if (el.getAttribute("title")) return clean(el.getAttribute("title"));
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return "";
    return clean(el.innerText || el.textContent || "");
  }

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function uniqueCss(el) {
    if (el.id && document.querySelectorAll("#" + cssEscape(el.id)).length === 1) return "#" + cssEscape(el.id);
    var testid = el.getAttribute("data-testid");
    if (testid) {
      var sel = "[data-testid=\\"" + testid.replace(/"/g, "\\\\\\"") + "\\"]";
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      var candidate = parts.join(" > ");
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      node = parent;
    }
    return undefined;
  }

  var CONTAINER = "dialog,[role=dialog],[role=alertdialog],fieldset,[role=group],[role=region],section,form," +
    "[role=form],nav,[role=navigation],aside,[role=complementary],tr,[role=row],li,[role=listitem],[role=tabpanel],[role=menu]";

  // A container's own name only: a whole form's text is no name. Rows and list items are named
  // by their text, as the accessibility tree names them.
  function containerName(node, role) {
    var aria = node.getAttribute("aria-label");
    if (aria) return clean(aria);
    var by = node.getAttribute("aria-labelledby");
    if (by) return clean(byIds(by));
    if (node.tagName === "FIELDSET") {
      var legend = node.querySelector("legend");
      if (legend) return clean(legend.textContent || "");
    }
    if (role === "row" || role === "listitem") return clean(node.innerText || "");
    return "";
  }

  function containers(el) {
    var out = [];
    var node = el.parentElement;
    while (node && node !== document.body && out.length < 3) {
      if (node.matches && node.matches(CONTAINER)) {
        var role = node.getAttribute("role") || implicitRole(node);
        var name = containerName(node, role);
        if (name || role === "row" || role === "listitem") out.push({ marker: mark(node), role: role, name: name || undefined });
      }
      node = node.parentElement;
    }
    return out;
  }

  function info(el) {
    var out = { marker: mark(el), tag: el.tagName.toLowerCase() };
    var type = el.getAttribute("type");
    if (type) out.type = type.toLowerCase();
    if (el.getAttribute("role")) out.role = el.getAttribute("role");
    var imp = implicitRole(el);
    if (imp) out.implicitRole = imp;
    var name = nameOf(el);
    if (name) out.name = name;
    var label = labelFor(el);
    if (label && label !== el) {
      var t = labelTexts(label);
      if (t.direct) out.labelDirect = t.direct;
      if (t.full) out.labelFull = t.full;
    }
    if (el.getAttribute("placeholder")) out.placeholder = clean(el.getAttribute("placeholder"));
    var text = clean(el.innerText || "", 80);
    if (text) out.text = text;
    var css = uniqueCss(el);
    if (css) out.css = css;
    out.containers = containers(el);
    return out;
  }

  function isTextEntry(el) {
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    var type = (el.getAttribute("type") || "text").toLowerCase();
    return ["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"].indexOf(type) < 0;
  }

  function isField(el) {
    var role = el.getAttribute("role") || implicitRole(el);
    return ["checkbox", "radio", "switch", "option", "combobox", "menuitemcheckbox", "menuitemradio"].indexOf(role) >= 0;
  }

  // --- the person's actions --------------------------------------------------------------

  function picking(ev) {
    if (!mode || inToolbar(ev)) return false;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    return true;
  }

  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu"].forEach(function (type) {
    window.addEventListener(type, function (ev) { picking(ev); }, true);
  });

  window.addEventListener("pointerdown", function (ev) {
    if (mode || inToolbar(ev)) return;
    var el = interactive(ev.target);
    if (el && el.nodeType === 1 && !isTextEntry(el) && el.tagName !== "SELECT") send({ kind: "hover", el: info(el) });
  }, true);

  window.addEventListener("click", function (ev) {
    if (picking(ev)) {
      var picked = mode;
      setMode(null);
      send({ kind: picked, el: info(ev.target) });
      return;
    }
    if (inToolbar(ev)) return;
    var el = interactive(ev.target);
    if (!el || el.nodeType !== 1) return;
    // A label's click is passed on to its control as a second click: record that one.
    if (el.tagName === "LABEL" && el.control) return;
    var label = ev.target.closest && ev.target.closest("label");
    if (label && label.control && label.control !== el && !el.closest("a,button")) return;
    // Typing is recorded as a fill, which focuses the field itself; a native select as a choice.
    if (isTextEntry(el) || el.tagName === "SELECT" || el.tagName === "OPTION") return;
    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file") return;
    lastClickAt = Date.now();
    send({ kind: "click", el: info(el), field: isField(el) });
  }, true);

  window.addEventListener("input", function (ev) {
    if (inToolbar(ev)) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || !isTextEntry(el)) return;
    var secret = el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
    var value = el.isContentEditable ? el.innerText : el.value;
    send({ kind: "input", el: info(el), value: secret ? "" : String(value), secret: secret });
  }, true);

  window.addEventListener("change", function (ev) {
    if (inToolbar(ev)) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === "SELECT") {
      var opt = el.options[el.selectedIndex];
      if (opt) send({ kind: "select", el: info(el), option: clean(opt.label || opt.textContent, 200) || opt.value });
    } else if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file") {
      send({ kind: "file", el: info(el) });
    }
  }, true);

  // Enter in a field submits its form without a click on anything: say which button that was.
  window.addEventListener("submit", function (ev) {
    if (Date.now() - lastClickAt < 400) return;
    var submitter = ev.submitter || (ev.target && ev.target.querySelector && ev.target.querySelector("button[type=submit],input[type=submit],button:not([type])"));
    send({ kind: "submit", submitter: submitter ? info(submitter) : undefined });
  }, true);

  window.addEventListener("mouseover", function (ev) {
    if (inToolbar(ev)) return;
    if (mode) { outline(ev.target); return; }
    var el = interactive(ev.target);
    if (!el || el === hovered || el.nodeType !== 1 || el === document.body) return;
    hovered = el;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      if (hovered === el && el.isConnected) send({ kind: "hover", el: info(el) });
    }, 120);
  }, true);

  window.addEventListener("keydown", function (ev) {
    if (mode && ev.key === "Escape" && !inToolbar(ev)) { ev.preventDefault(); setMode(null); }
  }, true);

  // --- toolbar ----------------------------------------------------------------------------

  var CSS_TEXT = [
    ":host{all:initial}",
    ".bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:6px;",
    "padding:6px 8px;border-radius:999px;background:#111827;color:#f9fafb;font:13px/1.2 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}",
    ".dot{width:10px;height:10px;border-radius:50%;background:#ef4444;margin:0 4px 0 6px}",
    ".status{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:4px;color:#d1d5db}",
    "button{all:unset;cursor:pointer;white-space:nowrap;padding:6px 10px;border-radius:999px;background:#374151;color:#f9fafb}",
    "button:hover{background:#4b5563}button.on{background:#2563eb}button.finish{background:#16a34a}",
    "input{all:unset;width:220px;padding:6px 10px;border-radius:999px;background:#f9fafb;color:#111827}",
    ".hidden{display:none}",
    ".box{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;border-radius:4px;background:rgba(37,99,235,.08)}"
  ].join("");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function build() {
    if (host || !document.body) return;
    host = document.createElement("aida-recorder");
    var root = host.attachShadow({ mode: "closed" });
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.appendChild(el("style", "", CSS_TEXT));
    }
    var bar = el("div", "bar");
    bar.appendChild(el("span", "dot"));
    ui.status = el("span", "status", "Recording");
    bar.appendChild(ui.status);
    ui.point = el("button", "", "Point at");
    ui.point.title = "Click something on the page to point it out in this step";
    ui.expect = el("button", "", "Check shown");
    ui.expect.title = "Click something on the page that should be showing now";
    ui.note = el("button", "", "Note");
    ui.note.title = "Say what the step you just did is for";
    ui.step = el("button", "", "New step");
    ui.step.title = "Start a new step here";
    ui.undo = el("button", "", "Undo");
    ui.undo.title = "Forget the last thing recorded";
    ui.finish = el("button", "finish", "Finish");
    ui.input = el("input", "hidden");
    [ui.point, ui.expect, ui.note, ui.step, ui.undo, ui.input, ui.finish].forEach(function (b) { bar.appendChild(b); });
    root.appendChild(bar);
    ui.box = el("div", "box hidden");
    root.appendChild(ui.box);

    ui.point.addEventListener("click", function () { setMode(mode === "point" ? null : "point"); });
    ui.expect.addEventListener("click", function () { setMode(mode === "expect" ? null : "expect"); });
    ui.undo.addEventListener("click", function () { send({ kind: "undo" }); });
    ui.finish.addEventListener("click", function () {
      ui.status.textContent = "Saving…";
      send({ kind: "finish" });
    });
    ui.note.addEventListener("click", function () { ask("note", "What is this step for?"); });
    ui.step.addEventListener("click", function () { ask("step", "Next step's title (optional)"); });
    ui.input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        var value = ui.input.value.trim();
        var kind = ui.input.dataset.kind;
        closeInput();
        if (kind === "note" && value) send({ kind: "note", text: value });
        if (kind === "step") send({ kind: "step", title: value || undefined });
      } else if (ev.key === "Escape") {
        closeInput();
      }
    });
    // Keys typed into the toolbar mustn't reach the app's own shortcuts.
    ["keydown", "keyup", "keypress", "input"].forEach(function (type) {
      host.addEventListener(type, function (ev) { ev.stopPropagation(); });
    });
    document.documentElement.appendChild(host);
    send({ kind: "hello" });
  }

  function ask(kind, placeholder) {
    ui.input.dataset.kind = kind;
    ui.input.placeholder = placeholder;
    ui.input.value = "";
    ui.input.classList.remove("hidden");
    ui.input.focus();
  }

  function closeInput() {
    ui.input.classList.add("hidden");
    ui.input.value = "";
  }

  function setMode(next) {
    mode = next;
    if (!host) return;
    ui.point.classList.toggle("on", mode === "point");
    ui.expect.classList.toggle("on", mode === "expect");
    if (mode) ui.status.textContent = mode === "point" ? "Click what to point at (Esc cancels)" : "Click what should be showing (Esc cancels)";
    else ui.box.classList.add("hidden");
  }

  function outline(target) {
    if (!host || !target || !target.getBoundingClientRect) return;
    var r = target.getBoundingClientRect();
    ui.box.style.left = r.left - 2 + "px";
    ui.box.style.top = r.top - 2 + "px";
    ui.box.style.width = r.width + "px";
    ui.box.style.height = r.height + "px";
    ui.box.classList.remove("hidden");
  }

  function showStatus(status) {
    if (!host || mode) return;
    if (status.finished) { ui.status.textContent = "Saved. You can close this window."; return; }
    var count = status.actions + (status.actions === 1 ? " action" : " actions");
    ui.status.textContent = status.last ? count + " · " + status.last : "Recording · " + count;
  }

  // The toolbar's buttons, callable from a script (tests drive the recorder this way).
  window.__aidaRecorderTool = function (name, value) {
    if (name === "point" || name === "expect") setMode(name);
    else if (name === "note" && value) send({ kind: "note", text: String(value) });
    else if (name === "step") send({ kind: "step", title: value ? String(value) : undefined });
    else if (name === "undo") send({ kind: "undo" });
    else if (name === "finish") send({ kind: "finish" });
  };

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
`;
