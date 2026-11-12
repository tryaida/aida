// Acme Repairs' screens, rendered on the server as plain HTML. Every control has a visible label
// and every region a heading, so the same names a person reads are the names a walkthrough (and a
// screen reader) finds them by.
import { ITEM_TYPES, NEXT_STEP, STATUSES, TURNAROUND_DAYS, statusLabel } from "./store.mjs";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Messages shown after a change, by the `done` code in the address (never free text from it). */
const DONE_MESSAGES = {
  created: (job) => `Job ${job.id} saved. It's on the list as Waiting.`,
  "in-progress": (job) => `Work started on ${job.id}.`,
  ready: (job) => `${job.id} is ready for pickup.`,
  collected: (job) => `${job.id} marked as collected.`,
  settings: () => "Settings saved.",
  "sample-data": () => "Sample data put back: every job and setting is as it was when the app started.",
};

function layout({ title, current, body, flash }) {
  const nav = [
    { href: "/jobs", label: "Jobs", id: "jobs" },
    { href: "/settings", label: "Settings", id: "settings" },
  ]
    .map((item) => `<li><a href="${item.href}"${item.id === current ? ' aria-current="page"' : ""}>${item.label}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Acme Repairs</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.json">
<link rel="stylesheet" href="/styles.css">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/jobs"><img src="/icon.svg" alt="" width="30" height="30"><span>Acme Repairs</span></a>
    <nav aria-label="Main"><ul>${nav}</ul></nav>
  </div>
</header>
<main id="main" tabindex="-1">
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ""}
${body}
</main>
<footer class="footer">Acme Repairs · sample data, kept in memory</footer>
</body>
</html>
`;
}

function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(statusLabel(status))}</span>`;
}

function flashFor(done, job) {
  const message = DONE_MESSAGES[done];
  return message ? message(job) : undefined;
}

export function jobsPage({ jobs, counts, q, status }) {
  const filters = [{ id: "", label: "All" }, ...STATUSES]
    .map((s) => {
      const href = s.id ? `/jobs?status=${s.id}` : "/jobs";
      const count = s.id ? counts[s.id] : counts.all;
      const current = (status || "") === s.id;
      // The count describes the link rather than naming it: the link is "Waiting", as the
      // walkthroughs and screen readers call it, not "Waiting 3".
      const countId = `count-${s.id || "all"}`;
      return `<li><a href="${href}"${current ? ' aria-current="page"' : ""} aria-describedby="${countId}">${esc(s.label)} <span class="count" id="${countId}" aria-hidden="true">${count}<span class="visually-hidden"> ${count === 1 ? "job" : "jobs"}</span></span></a></li>`;
    })
    .join("");
  const rows = jobs
    .map(
      (j) => `<tr data-search="${esc([j.id, j.customer.name, j.item, j.customer.phone, j.type].join(" ").toLowerCase())}">
  <td class="job-number">${esc(j.id)}</td>
  <td><a href="/jobs/${esc(j.id)}">${esc(j.customer.name)}</a></td>
  <td>${esc(j.item)}</td>
  <td>${badge(j.status)}</td>
</tr>`,
    )
    .join("\n");
  const emptyText = q ? `No jobs match “${esc(q)}”.` : "No jobs here yet.";
  const body = `
<div class="page-head">
  <div>
    <h1>Repair jobs</h1>
    <p class="lede" id="job-count">${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}</p>
  </div>
  <a class="button button-primary" href="/jobs/new">New job</a>
</div>
<div class="toolbar">
  <form role="search" class="search" action="/jobs" method="get" aria-label="Jobs">
    <label for="q">Search jobs</label>
    <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Name, item or job number" autocomplete="off" data-live-search>
    ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ""}
  </form>
  <nav class="filters" aria-label="Filter by status"><ul>${filters}</ul></nav>
</div>
<div class="card table-card">
  <table class="jobs">
    <caption class="visually-hidden">Repair jobs, newest first</caption>
    <thead><tr><th scope="col">Job</th><th scope="col">Customer</th><th scope="col">Item</th><th scope="col">Status</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="empty"${jobs.length > 0 ? " hidden" : ""} data-empty>${emptyText}</p>
</div>`;
  return layout({ title: "Repair jobs", current: "jobs", body });
}

function field({ id, label, hint, error, input }) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return `<div class="field${error ? " field-error" : ""}">
  <label for="${id}">${esc(label)}</label>
  ${error ? `<p class="error" id="${id}-error">${esc(error)}</p>` : ""}
  ${input(describedBy ? ` aria-describedby="${describedBy}"` : "", error ? ' aria-invalid="true"' : "")}
  ${hint ? `<p class="hint" id="${id}-hint">${esc(hint)}</p>` : ""}
</div>`;
}

function errorSummary(errors, order) {
  const keys = order.filter((k) => errors[k]);
  if (keys.length === 0) return "";
  const items = keys.map((k) => `<li><a href="#${k}">${esc(errors[k])}</a></li>`).join("");
  return `<div class="error-summary" role="alert" aria-labelledby="error-summary-title" tabindex="-1">
  <h2 id="error-summary-title">Check the highlighted ${keys.length === 1 ? "detail" : "details"}</h2>
  <ul>${items}</ul>
</div>`;
}

export function newJobPage({ values = {}, errors = {}, settings }) {
  const v = (k) => esc(values[k] ?? "");
  const typeOptions = ITEM_TYPES.map((t) => `<option${values.type === t ? " selected" : ""}>${esc(t)}</option>`).join("");
  const emailLabel = settings.requireEmail ? "Email" : "Email (optional)";
  const body = `
<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/jobs">Jobs</a></li><li><span aria-current="page">New job</span></li></ol></nav>
<h1>Take in a repair</h1>
<p class="lede">Standard turnaround is ${settings.turnaroundDays} working days.</p>
${errorSummary(errors, ["name", "phone", "email", "item", "type", "problem"])}
<form class="card form" action="/jobs" method="post" novalidate>
  <fieldset>
    <legend>Customer</legend>
    ${field({ id: "name", label: "Customer name", error: errors.name, input: (d, i) => `<input id="name" name="name" type="text" autocomplete="off" value="${v("name")}"${d}${i}>` })}
    <div class="field-row">
      ${field({ id: "phone", label: "Phone", error: errors.phone, input: (d, i) => `<input id="phone" name="phone" type="tel" autocomplete="off" value="${v("phone")}"${d}${i}>` })}
      ${field({ id: "email", label: emailLabel, error: errors.email, input: (d, i) => `<input id="email" name="email" type="email" autocomplete="off" value="${v("email")}"${d}${i}>` })}
    </div>
  </fieldset>
  <fieldset>
    <legend>Item</legend>
    <div class="field-row">
      ${field({ id: "item", label: "Item", hint: "For example: Road bike, Toaster", error: errors.item, input: (d, i) => `<input id="item" name="item" type="text" autocomplete="off" value="${v("item")}"${d}${i}>` })}
      ${field({ id: "type", label: "Type", error: errors.type, input: (d, i) => `<select id="type" name="type"${d}${i}><option value="">Choose a type</option>${typeOptions}</select>` })}
    </div>
    ${field({ id: "problem", label: "What's wrong", hint: "In the customer's words is fine.", error: errors.problem, input: (d, i) => `<textarea id="problem" name="problem" rows="3"${d}${i}>${v("problem")}</textarea>` })}
  </fieldset>
  <div class="actions">
    <button class="button button-primary" type="submit">Save job</button>
    <a class="button" href="/jobs">Cancel</a>
  </div>
</form>`;
  return layout({ title: "Take in a repair", current: "jobs", body });
}

export function jobPage({ job, done, settings }) {
  const step = NEXT_STEP[job.status];
  let action = `<p class="muted">Nothing left to do: the customer has collected it.</p>`;
  if (step && step.to === "ready") {
    action = `<button class="button button-primary" type="button" data-open-dialog="ready-dialog">${esc(step.action)}</button>`;
  } else if (step) {
    action = `<form action="/jobs/${esc(job.id)}/status" method="post"><input type="hidden" name="status" value="${esc(step.to)}"><button class="button button-primary" type="submit">${esc(step.action)}</button></form>`;
  }
  const history = job.history.map((h) => `<li>${esc(h)}</li>`).join("");
  const email = job.customer.email ? `<a href="mailto:${esc(job.customer.email)}">${esc(job.customer.email)}</a>` : `<span class="muted">None given</span>`;
  const body = `
<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/jobs">Jobs</a></li><li><span aria-current="page">${esc(job.id)}</span></li></ol></nav>
<div class="page-head">
  <div>
    <h1>${esc(job.id)}: ${esc(job.item)}</h1>
    <p class="lede">${esc(job.type)} · promised within ${settings.turnaroundDays} working days</p>
  </div>
</div>
<div class="detail-grid">
  <div class="stack">
    <section class="card" aria-labelledby="customer-heading">
      <h2 id="customer-heading">Customer</h2>
      <dl class="facts">
        <div><dt>Name</dt><dd>${esc(job.customer.name)}</dd></div>
        <div><dt>Phone</dt><dd>${esc(job.customer.phone)}</dd></div>
        <div><dt>Email</dt><dd>${email}</dd></div>
      </dl>
    </section>
    <section class="card" aria-labelledby="problem-heading">
      <h2 id="problem-heading">What's wrong</h2>
      <p>${esc(job.problem)}</p>
    </section>
  </div>
  <section class="card status-card" aria-labelledby="status-heading">
    <h2 id="status-heading">Status</h2>
    <p class="status-now">${badge(job.status)}</p>
    ${action}
    <h3>History</h3>
    <ol class="history">${history}</ol>
  </section>
</div>
${
  step && step.to === "ready"
    ? `<dialog id="ready-dialog" aria-labelledby="ready-title">
  <form action="/jobs/${esc(job.id)}/status" method="post">
    <h2 id="ready-title">Mark ${esc(job.id)} ready for pickup</h2>
    <p>${esc(job.customer.name)} can collect it from the front desk.</p>
    <input type="hidden" name="status" value="ready">
    <div class="field">
      <label for="note">Note for the front desk (optional)</label>
      <textarea id="note" name="note" rows="2"></textarea>
    </div>
    <div class="actions">
      <button class="button button-primary" type="submit">Mark ready</button>
      <button class="button" type="button" data-close-dialog>Cancel</button>
    </div>
  </form>
</dialog>`
    : ""
}`;
  return layout({ title: `${job.id}: ${job.item}`, current: "jobs", body, flash: flashFor(done, job) });
}

export function settingsPage({ values, errors = {}, done }) {
  const v = (k) => esc(values[k] ?? "");
  const turnaround = TURNAROUND_DAYS.map((d) => `<option value="${d}"${Number(values.turnaroundDays) === d ? " selected" : ""}>${d} working days</option>`).join("");
  const body = `
<h1>Settings</h1>
<p class="lede">How the shop appears on jobs, and what new jobs ask for.</p>
${errorSummary(errors, ["shopName", "turnaroundDays"])}
<form class="card form" action="/settings" method="post" novalidate>
  <fieldset>
    <legend>Shop details</legend>
    ${field({ id: "shopName", label: "Shop name", error: errors.shopName, input: (d, i) => `<input id="shopName" name="shopName" type="text" value="${v("shopName")}"${d}${i}>` })}
    <div class="field-row">
      ${field({ id: "shopPhone", label: "Shop phone", input: (d, i) => `<input id="shopPhone" name="phone" type="tel" value="${v("phone")}"${d}${i}>` })}
      ${field({ id: "hours", label: "Opening hours", hint: "Shown on pickup notes.", input: (d, i) => `<input id="hours" name="hours" type="text" value="${v("hours")}"${d}${i}>` })}
    </div>
  </fieldset>
  <fieldset>
    <legend>New jobs</legend>
    ${field({ id: "turnaroundDays", label: "Standard turnaround", hint: "What the shop promises when it takes in a repair.", error: errors.turnaroundDays, input: (d, i) => `<select id="turnaroundDays" name="turnaroundDays"${d}${i}>${turnaround}</select>` })}
    <div class="check">
      <input id="requireEmail" name="requireEmail" type="checkbox"${values.requireEmail ? " checked" : ""}>
      <label for="requireEmail">Ask for an email address on every new job</label>
    </div>
  </fieldset>
  <div class="actions">
    <button class="button button-primary" type="submit">Save settings</button>
  </div>
</form>
<section class="card sample-data" aria-labelledby="sample-heading">
  <h2 id="sample-heading">Sample data</h2>
  <p>Put back the sample jobs and settings this app starts with. Anything you've added or changed is lost.</p>
  <form action="/settings/sample-data" method="post">
    <button class="button" type="submit">Reset sample data</button>
  </form>
</section>`;
  return layout({ title: "Settings", current: "settings", body, flash: flashFor(done) });
}

export function notFoundPage() {
  const body = `<h1>Page not found</h1><p>There's nothing at this address. <a href="/jobs">Go to the jobs list</a>.</p>`;
  return layout({ title: "Page not found", current: "", body });
}
