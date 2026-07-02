import { S } from "./state.mjs";
import { syncUrl } from "./url-state.mjs";

// ---------- Click-to-select chart ↔ table ----------
export function wireSelect(svgEl, rightEl) {
  const dots = svgEl.querySelectorAll(".dot");
  const rows = rightEl.querySelectorAll("tr.call[data-idx]");
  const rowMap = {};
  rows.forEach(r => rowMap[r.dataset.idx] = r);
  const dotMap = {};
  dots.forEach(d => {
    const i = d.getAttribute("data-idx");
    (dotMap[i] = dotMap[i] || []).push(d);
  });

  let selected = null; // current idx string

  function clearSelection() {
    if (!selected) return;
    (dotMap[selected] || []).forEach(d => {
      if (d.tagName === "circle" && d.getAttribute("data-orig-r")) d.setAttribute("r", d.getAttribute("data-orig-r"));
      d.removeAttribute("stroke"); d.removeAttribute("stroke-width");
    });
    const r = rowMap[selected]; if (r) r.classList.remove("selected");
    selected = null;
  }

  function selectIdx(idx, opts) {
    if (selected === idx) { clearSelection(); return; }
    clearSelection();
    selected = idx;
    (dotMap[idx] || []).forEach(d => {
      if (d.tagName === "circle") {
        d.setAttribute("data-orig-r", d.getAttribute("r") || "2");
        d.setAttribute("r", Number(d.getAttribute("r")) + 3);
      }
      d.setAttribute("stroke", "#fff"); d.setAttribute("stroke-width", "1.4");
    });
    const r = rowMap[idx];
    if (r) {
      r.classList.add("selected");
      if (opts && opts.scroll) r.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  dots.forEach(d => {
    d.style.cursor = "pointer";
    d.addEventListener("click", e => { e.stopPropagation(); selectIdx(d.getAttribute("data-idx"), { scroll: true }); });
  });
  rows.forEach(r => {
    r.addEventListener("click", () => selectIdx(r.dataset.idx, { scroll: false }));
  });
}

// Progressive disclosure for the detail table: clicking a step row toggles its
// (initially collapsed) tool-detail row.
export function wireExpand(rightEl) {
  rightEl.querySelectorAll("tr.call.expandable").forEach(row => {
    row.addEventListener("click", () => {
      const tools = row.nextElementSibling;
      if (!tools || !tools.classList.contains("tools")) return;
      const nowCollapsed = tools.classList.toggle("collapsed");
      row.classList.toggle("expanded", !nowCollapsed);
    });
  });
  // second-level disclosure: each tool shows a one-line summary; clicking it
  // reveals the full args/result detail.
  rightEl.querySelectorAll(".tool .tool-head").forEach(head => {
    head.addEventListener("click", e => {
      e.stopPropagation();
      const detail = head.nextElementSibling;
      if (!detail || !detail.classList.contains("tool-detail")) return;
      detail.classList.toggle("collapsed");
      head.closest(".tool").classList.toggle("expanded");
    });
  });
  // result preview clamp toggles (live inside the tools rows, not the call rows)
  rightEl.querySelectorAll("button.res-toggle").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const body = btn.previousElementSibling;
      if (!body) return;
      const clamped = body.classList.toggle("clamped");
      btn.textContent = clamped ? "show more" : "show less";
    });
  });
  // copy-to-clipboard: grab the full (unclamped, untruncated) message text.
  rightEl.querySelectorAll("button.copy-btn").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const text = decodeURIComponent(btn.dataset.copy || "");
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        // fallback for non-secure contexts where navigator.clipboard is unavailable
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (_) { /* ignore */ }
        document.body.removeChild(ta);
      }
      const orig = btn.textContent;
      btn.textContent = "copied!";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
    });
  });
}

// Toggle between the per-turn table, by-tool, and by-file views inside the detail pane.
// The choice is global state (S.DVIEW, URL-persisted) so every session opens to the same view.
export function wireDetailViews(rightEl) {
  const btns = [...rightEl.querySelectorAll(".dview-btn")];
  function activate(v, save) {
    const btn = btns.find(b => b.dataset.dview === v) || btns[0];
    if (!btn) return;
    btns.forEach(b => b.classList.toggle("active", b === btn));
    rightEl.querySelectorAll(".dview").forEach(d => { d.hidden = d.dataset.dview !== btn.dataset.dview; });
    if (save) { S.DVIEW = btn.dataset.dview; syncUrl(); }
  }
  btns.forEach(btn => btn.addEventListener("click", () => activate(btn.dataset.dview, true)));
  if (S.DVIEW !== "turns") activate(S.DVIEW, false);
}

// Progressive disclosure for the by-tool view: click a tool row to reveal its callers,
// click a caller row to reveal that tool's params/result. (The inner per-tool blocks
// reuse the same markup as the turns table, so wireExpand handles their second level.)
export function wireToolAgg(rightEl) {
  rightEl.querySelectorAll("tr.tagg-tool.expandable, tr.tagg-caller.expandable").forEach(row => {
    row.addEventListener("click", e => {
      const next = row.nextElementSibling;
      if (!next || !(next.classList.contains("tagg-sub") || next.classList.contains("tagg-params"))) return;
      e.stopPropagation();
      const nowCollapsed = next.classList.toggle("collapsed");
      row.classList.toggle("expanded", !nowCollapsed);
    });
  });
}

// Segmented tool tabs: switch which per-tool panel is visible within the by-tool view.
// The selected TOOL NAME (not index) persists via S.DTAB, so opening another session lands
// on the same tool's tab when that session has it (else overview).
export function wireToolTabs(rightEl) {
  rightEl.querySelectorAll(".tagg-tabs").forEach(tabsEl => {
    const wrap = tabsEl.parentElement;
    const btns = [...tabsEl.querySelectorAll(".tagg-tab")];
    const panels = [...wrap.querySelectorAll(".tagg-panel")];
    function activate(btn, save) {
      const tab = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle("active", b === btn));
      panels.forEach(p => { p.hidden = p.dataset.tab !== tab; });
      if (save) { S.DTAB = btn.dataset.name || "overview"; syncUrl(); }
    }
    btns.forEach(btn => btn.addEventListener("click", () => activate(btn, true)));
    if (S.DTAB !== "overview") {
      const btn = btns.find(b => b.dataset.name === S.DTAB);
      if (btn) activate(btn, false);
    }
  });
}

// Table ⇄ line-heatmap toggle inside the read_file panel; persists via S.RFVIEW/the URL.
export function wireRfViews(rightEl) {
  rightEl.querySelectorAll(".rf-toggle").forEach(toggle => {
    const wrap = toggle.parentElement;
    const btns = [...toggle.querySelectorAll(".rf-btn")];
    const views = [...wrap.querySelectorAll(":scope > .rf-view")];
    function activate(v, save) {
      if (!btns.some(b => b.dataset.rfview === v)) return;
      btns.forEach(b => b.classList.toggle("active", b.dataset.rfview === v));
      views.forEach(view => { view.hidden = view.dataset.rfview !== v; });
      if (save) { S.RFVIEW = v; syncUrl(); }
    }
    btns.forEach(btn => btn.addEventListener("click", () => activate(btn.dataset.rfview, true)));
    if (S.RFVIEW !== "table") activate(S.RFVIEW, false);
  });
}

// Click a multi-agent file in the heatmap to expand/collapse its per-agent split.
// Each file toggles independently.
export function wireHeatExpand(rightEl) {
  rightEl.querySelectorAll(".heat-file.expandable").forEach(row => {
    row.addEventListener("click", () => {
      const split = row.nextElementSibling;
      if (!split || !split.classList.contains("heat-split")) return;
      const collapsed = split.classList.toggle("collapsed");
      row.classList.toggle("expanded", !collapsed);
    });
  });
}

// One top-level file-path filter for the whole detail pane. Case-insensitive substring
// match against the FULL path (so "/docs" finds everything under any docs folder),
// applied to every element that carries data-path: the by-tool per-tool tables, the
// read_file line heatmap, and the by-file table. Generic-tool rows match on file paths
// pulled from their args (falling back to the arg gist). Persists via S.DFILTER/the URL.
export function applyDetailFilter(rightEl) {
  const q = S.DFILTER.trim().toLowerCase();
  let shown = 0, total = 0;
  rightEl.querySelectorAll("tr.srow[data-path]").forEach(row => {
    const hit = !q || (row.dataset.path || "").includes(q);
    total++; if (hit) shown++;
    row.hidden = !hit;
    const d = row.nextElementSibling;
    if (d && d.classList.contains("srow-detail")) d.hidden = !hit; // .collapsed still governs when shown
  });
  rightEl.querySelectorAll(".heat-file[data-path]").forEach(el => {
    const hit = !q || (el.dataset.path || "").includes(q);
    total++; if (hit) shown++;
    el.hidden = !hit;
    const split = el.nextElementSibling;
    if (split && split.classList.contains("heat-split")) split.hidden = !hit;
  });
  const count = rightEl.querySelector("#dfilterCount");
  if (count) count.textContent = q ? `${shown} / ${total} rows match` : "";
}

export function wireDetailFilter(rightEl) {
  const input = rightEl.querySelector("#dviewFilter");
  if (!input) return;
  input.addEventListener("input", () => {
    S.DFILTER = input.value;
    applyDetailFilter(rightEl);
    syncUrl();
  });
  if (S.DFILTER) applyDetailFilter(rightEl);
}

// Click-to-expand rows in the per-tool file/invocation tables (params + result).
export function wireFileRows(rightEl) {
  rightEl.querySelectorAll("tr.srow.expandable").forEach(row => {
    row.addEventListener("click", e => {
      const d = row.nextElementSibling;
      if (!d || !d.classList.contains("srow-detail")) return;
      e.stopPropagation();
      const collapsed = d.classList.toggle("collapsed");
      row.classList.toggle("expanded", !collapsed);
    });
  });
}

// Make a table with th[data-sort] click-sortable, keeping each row's expandable
// detail sibling glued to it. Re-sorts the existing DOM rows (no re-render).
export function wireSortable(table) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  let curKey = null, curDir = 1;
  const headers = [...table.querySelectorAll("th[data-sort]")];
  headers.forEach(th => {
    th.classList.add("sortable");
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      const numeric = th.dataset.sortType === "num";
      if (curKey === key) curDir = -curDir; else { curKey = key; curDir = 1; }
      headers.forEach(h => h.removeAttribute("data-dir"));
      th.setAttribute("data-dir", curDir > 0 ? "asc" : "desc");
      // pair each main row with its (optional) detail row
      const pairs = [];
      [...tbody.children].forEach(tr => {
        if (tr.classList.contains("srow")) pairs.push({ main: tr, detail: null });
        else if (pairs.length && tr.classList.contains("srow-detail")) pairs[pairs.length - 1].detail = tr;
      });
      pairs.sort((a, z) => {
        const av = a.main.dataset[key] ?? "", zv = z.main.dataset[key] ?? "";
        return (numeric ? (Number(av) - Number(zv)) : String(av).localeCompare(String(zv))) * curDir;
      });
      pairs.forEach(p => { tbody.appendChild(p.main); if (p.detail) tbody.appendChild(p.detail); });
    });
  });
}

