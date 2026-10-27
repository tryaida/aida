/*!
 * aida help chat — drop-in widget (scope.md "Help chat": "a drop-in widget inside the app
 * (one script tag or a React component)"; build-plan.md M15 step 6).
 *
 * Usage, in the app being documented (not the help site itself):
 *   <script src="https://your-help-site.example.com/widget.js" data-help-url="https://your-help-site.example.com"></script>
 *
 * Sends `location.pathname` as `currentPath` on every question, so retrieval can boost the
 * walkthrough the reader is actually looking at. Talks to `<data-help-url>/api/chat` directly —
 * that route must list this app's origin in `aida.config.ts`'s `chat.allowedOrigins` (see
 * packages/engine/src/chat/cors.ts) or the browser will block the response.
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

  var busy = false;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) node.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Shadow DOM keeps the host app's CSS and the widget's apart in both directions.
  var host = el("div", { "data-aida-widget": "" });
  var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    ".dg{--p:#111827;--pf:#fff;--font:system-ui,-apple-system,'Segoe UI',sans-serif;position:fixed;bottom:16px;right:16px;z-index:2147483000;font:14px/1.45 var(--font);color:#111827}",
    ".dg *{box-sizing:border-box;font:inherit}",
    ".panel{display:none;flex-direction:column;width:min(24rem,calc(100vw - 32px));height:min(34rem,calc(100vh - 32px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 24px 60px -12px rgba(15,23,42,.35);overflow:hidden}",
    ".panel.open{display:flex}",
    ".head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #eef0f3;background:#fafbfc}",
    ".mark{width:32px;height:32px;border-radius:999px;background:var(--p);color:var(--pf);display:grid;place-items:center;flex:none;overflow:hidden}",
    ".mark img{width:22px;height:22px;object-fit:contain}",
    ".grow{flex:1;min-width:0}.new{display:none}.new.show{display:block}",
    ".title{font-weight:600}.sub{font-size:12px;color:#6b7280}",
    ".x{border:0;background:none;cursor:pointer;color:#6b7280;padding:6px;border-radius:8px}.x:hover{background:#f1f3f5;color:#111827}",
    ".msgs{flex:1;overflow-y:auto;padding:14px}",
    ".empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#6b7280;gap:6px}",
    ".empty b{color:#111827}",
    ".b{margin:6px 0;padding:8px 12px;border-radius:16px;max-width:88%;word-wrap:break-word}",
    ".b.user{margin-left:auto;background:var(--p);color:var(--pf);border-bottom-right-radius:6px;white-space:pre-wrap}",
    ".b.assistant{background:#f1f3f5;border-bottom-left-radius:6px}",
    ".b p{margin:0 0 8px}.b p:last-child,.b ol:last-child,.b ul:last-child{margin-bottom:0}",
    ".b ol,.b ul{margin:0 0 8px;padding-left:20px}.b li{margin:2px 0}",
    ".b strong{font-weight:600}.b em{font-style:italic}",
    ".b code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:rgba(255,255,255,.7);border-radius:4px;padding:1px 4px}",
    ".cite{display:inline-grid;place-items:center;width:16px;height:16px;margin-left:2px;border-radius:999px;background:color-mix(in srgb,var(--p) 15%,transparent);color:var(--p);font-size:10px;font-weight:600;text-decoration:none;vertical-align:super;line-height:1}",
    ".cite:hover{background:var(--p);color:var(--pf)}",
    ".err{color:#b91c1c}",
    ".guide{display:flex;gap:10px;align-items:center;width:88%;margin:4px 0 12px;padding:8px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#111827;text-decoration:none}",
    ".guide:hover{border-color:var(--p)}",
    ".guide img{width:80px;height:56px;flex:none;object-fit:cover;object-position:top;border:1px solid #e5e7eb;border-radius:6px}",
    ".guide b{display:block;font-weight:600;line-height:1.3}.guide small{display:block;margin-top:2px;font-size:12px;color:#6b7280}.guide small span{color:var(--p);white-space:nowrap}",
    ".guide b .n{margin-right:4px;color:var(--p)}",
    ".cites{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 12px;font-size:12px;color:#6b7280}",
    ".cites a{display:inline-block;border:1px solid #e5e7eb;border-radius:999px;padding:3px 10px;color:#374151;text-decoration:none}",
    ".cites a:hover{border-color:var(--p);color:var(--p)}",
    "form{display:flex;gap:8px;align-items:center;padding:10px;border-top:1px solid #eef0f3;background:#fafbfc}",
    "input{flex:1;min-width:0;border:1px solid #d1d5db;border-radius:999px;padding:8px 14px;outline:none;background:#fff;color:#111827}",
    "input:focus{border-color:var(--p);box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 20%,transparent)}",
    ".send{width:36px;height:36px;border:0;border-radius:999px;background:var(--p);color:var(--pf);cursor:pointer;display:grid;place-items:center;flex:none}",
    ".toggle{display:inline-flex;align-items:center;gap:8px;border:0;background:var(--p);color:var(--pf);border-radius:999px;padding:10px 16px 10px 12px;cursor:pointer;font-weight:600;box-shadow:0 8px 24px -6px rgba(15,23,42,.35)}",
    ".toggle.hidden{display:none}",
  ].join("\n");
  shadow.appendChild(style);

  var ICON_CHAT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_SEND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';
  var ICON_NEW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  var ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  var root = el("div", { class: "dg" });
  var panel = el("div", { class: "panel", role: "dialog", "aria-label": "Help chat" });
  var mark = el("span", { class: "mark" });
  mark.innerHTML = ICON_CHAT;
  var titleEl = el("div", { class: "title" }, ["Help chat"]);
  var header = el("div", { class: "head" }, [mark, el("div", { class: "grow" }, [titleEl, el("div", { class: "sub" }, ["Answers come from the help guides"])])]);
  var newBtn = el("button", { class: "x new", type: "button", "aria-label": "Start a new chat", title: "New chat" });
  newBtn.innerHTML = ICON_NEW;
  header.appendChild(newBtn);
  var closeBtn = el("button", { class: "x", type: "button", "aria-label": "Close help chat" });
  closeBtn.innerHTML = ICON_X;
  header.appendChild(closeBtn);

  var messages = el("div", { class: "msgs" });
  var empty = el("div", { class: "empty" }, [
    el("b", {}, ["Ask a question"]),
    el("div", { style: "font-size:12px;max-width:16rem" }, ["You'll get a short answer and a link to the guide."]),
  ]);
  messages.appendChild(empty);
  var form = el("form", {});
  var input = el("input", { placeholder: "Ask a question…", "aria-label": "Ask the help chat" });
  var sendBtn = el("button", { type: "submit", class: "send", "aria-label": "Send" });
  sendBtn.innerHTML = ICON_SEND;
  form.appendChild(input);
  form.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(form);

  var toggle = el("button", { type: "button", class: "toggle" });
  toggle.innerHTML = ICON_CHAT;
  var toggleLabel = document.createTextNode("Ask a question");
  toggle.appendChild(toggleLabel);

  root.appendChild(panel);
  root.appendChild(toggle);
  shadow.appendChild(root);
  document.body.appendChild(host);

  // The help site's brand (written by the aida engine): colour, name, logo and font, so the
  // widget looks like part of the app rather than a third-party bolt-on.
  fetch(helpUrl + "/brand/theme.json")
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (t) {
      if (!t) return;
      if (t.primary) root.style.setProperty("--p", t.primary);
      if (t.primaryForeground) root.style.setProperty("--pf", t.primaryForeground);
      if (t.fontFamily) root.style.setProperty("--font", t.fontFamily);
      if (t.name) {
        titleEl.textContent = t.name + " help";
        panel.setAttribute("aria-label", t.name + " help chat");
      }
      if (t.logo) {
        mark.style.background = "#fff";
        mark.innerHTML = "";
        mark.appendChild(el("img", { src: helpUrl + t.logo, alt: "" }));
      }
    })
    .catch(function () {});

  // The conversation is kept in sessionStorage so it follows the reader from page to page of the
  // app and clears when the tab closes. `turns` holds what's on screen; `history` is derived.
  var STORAGE_KEY = "aida-help-chat";
  var turns = [];
  var isOpen = false;

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open: isOpen, turns: turns }));
    } catch (e) {}
  }

  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) return;
      var kept = (saved.turns || []).filter(function (t) {
        return t.role === "user" || t.done;
      });
      while (kept.length && kept[kept.length - 1].role === "user") kept.pop();
      turns = kept;
      isOpen = !!saved.open;
    } catch (e) {}
  }

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
        var list = el(block.kind, {});
        block.items.forEach(function (item) {
          var li = el("li", {});
          appendInline(li, item, citations);
          list.appendChild(li);
        });
        node.appendChild(list);
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
    var guides = sources.filter(procedureFor);
    guides.forEach(function (c) {
      var proc = procedureFor(c);
      var card = el("a", { class: "guide", href: helpUrl + c.url, target: "_blank", rel: "noreferrer" });
      if (proc.firstScreenshot) card.appendChild(el("img", { src: helpUrl + proc.firstScreenshot, alt: "" }));
      var meta = (proc.stepCount ? proc.stepCount + " steps" : "Guide") + (proc.firstVideoTimeSec !== undefined ? " · with video" : "") + " · ";
      var name = el("b", {}, guides.length > 1 ? [el("span", { class: "n" }, [String(c.n)]), c.title] : [c.title]);
      card.appendChild(el("div", {}, [name, el("small", {}, [meta, el("span", {}, ["Open guide →"])])]));
      messages.appendChild(card);
    });
    var others = sources.filter(function (c) {
      return !procedureFor(c);
    });
    if (!others.length) return;
    var row = el("div", { class: "cites" }, [guides.length ? "Also see" : "From"]);
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

  function fillAssistant(bubble, turn) {
    if (turn.text) renderMarkdown(bubble, turn.text, turn.citations);
    else bubble.textContent = turn.done ? "" : "…";
    if (turn.error) bubble.appendChild(el("div", { class: "err" }, [turn.error]));
  }

  function renderAll() {
    messages.textContent = "";
    if (!turns.length) messages.appendChild(empty);
    turns.forEach(function (turn) {
      var bubble = addBubble(turn.role);
      if (turn.role === "user") bubble.textContent = turn.text;
      else {
        fillAssistant(bubble, turn);
        renderSources(turn);
      }
    });
    newBtn.classList.toggle("show", turns.length > 0 && !busy);
    toggleLabel.textContent = turns.length ? "Continue chat" : "Ask a question";
    messages.scrollTop = messages.scrollHeight;
  }

  function setOpen(open) {
    isOpen = open;
    panel.classList.toggle("open", open);
    toggle.classList.toggle("hidden", open);
    if (open) {
      messages.scrollTop = messages.scrollHeight;
      input.focus();
    }
    save();
  }

  toggle.addEventListener("click", function () {
    setOpen(true);
  });
  closeBtn.addEventListener("click", function () {
    setOpen(false);
  });
  newBtn.addEventListener("click", function () {
    turns = [];
    save();
    renderAll();
    input.focus();
  });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });

  async function ask(question) {
    if (!question.trim() || busy) return;
    busy = true;
    var history = historyFromTurns();
    var turn = { role: "assistant", text: "" };
    turns.push({ role: "user", text: question }, turn);
    renderAll();
    var bubbles = messages.querySelectorAll(".b.assistant");
    var answerBubble = bubbles[bubbles.length - 1];

    try {
      var res = await fetch(helpUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, currentPath: location.pathname, history: history }),
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
            turn.citations = event.citations;
            turn.procedures = event.procedures;
          } else if (event.type === "delta") {
            turn.text += event.text;
            fillAssistant(answerBubble, turn);
            messages.scrollTop = messages.scrollHeight;
          } else if (event.type === "error") {
            turn.error = event.message;
          }
        }
      }
    } catch (err) {
      turn.error = "couldn't reach help chat";
    } finally {
      turn.done = true;
      busy = false;
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

  load();
  renderAll();
  if (isOpen) setOpen(true);
})();
