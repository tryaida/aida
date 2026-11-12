// Acme Repairs' small bits of browser behaviour: the jobs list filters as you type (pressing
// Enter still searches on the server), and the "Mark ready for pickup" dialog opens and closes.
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const search = document.querySelector("[data-live-search]");
  if (search) {
    const rows = [...document.querySelectorAll("tbody tr[data-search]")];
    const empty = document.querySelector("[data-empty]");
    const count = document.getElementById("job-count");
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const match = !query || row.dataset.search.includes(query);
        row.hidden = !match;
        if (match) shown++;
      }
      if (empty) {
        empty.hidden = shown > 0;
        if (shown === 0) empty.textContent = `No jobs match “${search.value.trim()}”.`;
      }
      if (count) count.textContent = `${shown} ${shown === 1 ? "job" : "jobs"}`;
    };
    search.addEventListener("input", filter);
  }

  for (const opener of document.querySelectorAll("[data-open-dialog]")) {
    const dialog = document.getElementById(opener.dataset.openDialog);
    if (!dialog) continue;
    opener.addEventListener("click", () => dialog.showModal());
    for (const closer of dialog.querySelectorAll("[data-close-dialog]")) {
      closer.addEventListener("click", () => dialog.close());
    }
  }
});
