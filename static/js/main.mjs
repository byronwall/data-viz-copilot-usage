import { S } from "./state.mjs";
import { calendarButtonLabel, escapeHtml, fmt, fmtAic, fmtCost, hasCostMetric, hms, niceCeil, qtyText, reasoningBadge, sourceLabelHtml, unitLabel } from "./format.mjs";
import { renderChart } from "./chart.mjs";
import { openModal } from "./modal.mjs";
import { getRangeTs, setRangeTs } from "./range.mjs";
import { applyUrlState, syncUrl } from "./url-state.mjs";
import { calPop, calTrigger, loadCalendar, renderCalendar } from "./calendar.mjs";

// ---------- Main load ----------
export let CURRENT_MAX_TOK = 0;

export async function loadSessions() {
  const [s, e] = getRangeTs();
  // drop the calendar highlight if the range no longer matches the selected day
  if (S.CAL_SELECTED) {
    const [yy, mm, dd] = S.CAL_SELECTED.split("-").map(Number);
    const dayStart = Math.floor(new Date(yy, mm - 1, dd).getTime() / 1000);
    if (s !== dayStart || e !== dayStart + 86400) {
      S.CAL_SELECTED = null;
      renderCalendar();
    }
  }
  const opts = new URLSearchParams({
    sort: document.getElementById("sort").value,
    limit: document.getElementById("limit").value,
    min_tokens: document.getElementById("min_tokens").value,
    source: S.SOURCE,
  });
  if (s) opts.set("start_ts", String(s));
  if (e) opts.set("end_ts", String(e));
  syncUrl();

  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  grid.innerHTML = `<div class="muted" style="padding:20px">loading…</div>`;
  empty.hidden = true;

  const resp = await fetch(`/api/sessions?${opts}`);
  const data = await resp.json();
  CURRENT_MAX_TOK = data.max_tok || 1000;
  const maxTok = niceCeil(CURRENT_MAX_TOK);

  document.getElementById("took").textContent = `(${data.took_ms} ms scan)`;

  LAST_SESSIONS = data.sessions;
  LAST_MAXTOK = maxTok;
  updateBanner();

  if (data.sessions.length === 0) {
    grid.innerHTML = "";
    document.getElementById("tableWrap").innerHTML = "";
    grid.hidden = true;
    document.getElementById("tableWrap").hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  applyView();
}

// ---------- Chart-grid / table views ----------
// Two renderings of the same session list (the "threads"): the SVG small-multiples
// grid, and a tabular rollup. Both route a row/card click to the same detail modal.
export let LAST_SESSIONS = [];
export let LAST_DISPLAY = [];     // what's actually on screen (combined or expanded)
export let LAST_MAXTOK = 1000;
// true → sub-agent (sub-agent + search-subagent) tokens stay folded into their parent (default).
// false → each sub-agent is split out as its own row/card, with its tokens removed from the parent.
// Column sort for the table view. key=null → keep the server's sort (the controls' sort key).
export let TABLE_SORT = { key: null, dir: -1 };

// Sum a sub-agent's per-turn tokens (the contribution it added to its parent's totals).
export function kidTotals(k) {
  let input = 0, cached = 0, output = 0, aic = 0, nc = 0;
  for (const c of k.calls) {
    input += c.input || 0; cached += c.cached || 0; output += c.output || 0;
    aic += c.aic || 0; if (c.compact) nc++;
  }
  return { input, cached, output, aic, n: k.calls.length, nc };
}

export function kidReasoning(k) {
  return [...new Set(k.calls.map(c => c.reasoning).filter(Boolean))].join("·");
}

// Expand each session into (parent-minus-its-sub-agents) + one standalone entry per sub-agent.
// Synthetic entries carry every field the table/chart renderers read, plus `_modal_sid` so a
// click routes to a real session detail (the search-subagent's own session, else the parent).
export function expandSessions(sessions) {
  const out = [];
  for (const s of sessions) {
    const kids = s.kids || [];
    if (!kids.length) { out.push({ ...s, _modal_sid: s.sid, n_subs: 0 }); continue; }
    let ki = 0, kc = 0, ko = 0, ka = 0, kn = 0, knc = 0;
    for (const k of kids) {
      const t = kidTotals(k);
      ki += t.input; kc += t.cached; ko += t.output; ka += t.aic; kn += t.n; knc += t.nc;
    }
    out.push({
      ...s,
      total_input: s.total_input - ki,
      total_cached: s.total_cached - kc,
      total_output: s.total_output - ko,
      total_aic: (s.total_aic || 0) - ka,
      n_requests: s.n_requests - kn,
      n_compactions: Math.max(0, (s.n_compactions || 0) - knc),
      kids: [],
      n_subs: kids.length,
      _modal_sid: s.sid,
    });
    kids.forEach((k, i) => {
      const t = kidTotals(k);
      const ts = k.calls.map(c => c.t);
      const dur = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
      out.push({
        sid: `${s.sid}::K${i}`,
        _modal_sid: (k.is_search_child && k.child_sid) ? k.child_sid : s.sid,
        _is_subagent: true, _all_turns: true, is_search_child: k.is_search_child,
        workspace: s.workspace,
        first_user: k.label,
        last_event_ts: s.last_event_ts, mtime: s.mtime,
        top_model: k.top_model || "?",
        reasoning: kidReasoning(k),
        total_input: t.input, total_cached: t.cached, total_output: t.output,
        total_aic: t.aic, n_requests: t.n, n_compactions: t.nc,
        duration_ms: dur,
        // chart payload: the sub-agent's own turns become the "main" line (cum from cum_offset)
        main: k.calls.map(c => ({ ...c, cum: c.cum_offset })),
        kids: [],
      });
    });
  }
  return out;
}

export function displaySessions() {
  return S.COMBINE
    ? LAST_SESSIONS.map(s => ({ ...s, _modal_sid: s.sid, n_subs: (s.kids || []).length }))
    : expandSessions(LAST_SESSIONS);
}

export function renderCards(sessions, maxTok) {
  const grid = document.getElementById("grid");
  grid.innerHTML = sessions.map(s =>
    `<div class="card" data-sid="${escapeHtml(s._modal_sid || s.sid)}">${renderChart(s, { maxTok })}</div>`
  ).join("");
  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(card.dataset.sid, maxTok));
  });
}

// One row per thread (session). Each column declares how to read its sort value and
// how to render its cell, so header-click sorting and rendering stay in lockstep.
export const uncachedTok = s => (s.total_input || 0) - (s.total_cached || 0);
export const TABLE_COLS = [
  { key: "time", label: "time", num: false, get: s => s.last_event_ts || s.mtime * 1000,
    render: s => `<span class="t-time">${new Date(s.last_event_ts || s.mtime * 1000).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>` },
  { key: "model", label: "model", num: false, get: s => s.top_model || "",
    render: s => `<span class="t-model">${escapeHtml(s.top_model || "?")}</span>` },
  { key: "reasoning", label: "reasoning", num: false, get: s => s.reasoning || "",
    render: s => reasoningBadge(s.reasoning) },
  { key: "thread", label: "thread (first user message)", num: false, get: s => (s.first_user || "").toLowerCase(),
    render: s => `${sourceLabelHtml(s)}<span class="t-thread">${escapeHtml(s.first_user || "(no user message)")}</span>` },
  { key: "n_requests", label: "req", num: true, get: s => s.n_requests || 0,
    render: s => fmt(s.n_requests) },
  { key: "n_subs", label: "subs", num: true, get: s => s.n_subs || 0,
    render: s => s.n_subs ? fmt(s.n_subs) : `<span style="color:#444">—</span>` },
  { key: "total_input", label: "input", num: true, get: s => s.total_input || 0,
    render: s => fmt(s.total_input) },
  { key: "total_cached", label: "cached", num: true, get: s => s.total_cached || 0,
    render: s => `<span class="num t-cached-sub">${fmt(s.total_cached)}</span>` },
  { key: "uncached", label: "uncached", num: true, get: uncachedTok,
    render: s => `<span class="num uncached">${fmt(uncachedTok(s))}</span>` },
  { key: "total_output", label: "output", num: true, get: s => s.total_output || 0,
    render: s => fmt(s.total_output) },
  { key: "total_aic", label: "AIC", num: true, get: s => s.total_aic || 0,
    render: s => s.total_aic ? `<span class="aic">${fmtAic(s.total_aic)}</span>` : `<span style="color:#444">—</span>` },
  { key: "duration", label: "duration", num: true, get: s => s.duration_ms || 0,
    render: s => hms(s.duration_ms) },
];

export function renderTable(sessions, maxTok) {
  const wrap = document.getElementById("tableWrap");
  let rows = sessions.slice();
  if (TABLE_SORT.key) {
    const col = TABLE_COLS.find(c => c.key === TABLE_SORT.key);
    rows.sort((a, b) => {
      const av = col.get(a), bv = col.get(b);
      return av < bv ? -TABLE_SORT.dir : av > bv ? TABLE_SORT.dir : 0;
    });
  }
  const thead = TABLE_COLS.map(c => {
    const arrow = TABLE_SORT.key === c.key ? (TABLE_SORT.dir > 0 ? " ▲" : " ▼") : "";
    const label = c.key === "total_aic" ? (hasCostMetric() ? unitLabel() : "cost") : c.label;
    return `<th data-key="${c.key}" class="${c.num ? "num" : ""}">${escapeHtml(label)}${arrow}</th>`;
  }).join("");
  const body = rows.map(s => {
    const tds = TABLE_COLS.map(c => `<td class="${c.num ? "num" : ""}">${c.render(s)}</td>`).join("");
    return `<tr class="trow${s._is_subagent ? " subagent-row" : ""}" data-sid="${escapeHtml(s._modal_sid || s.sid)}">${tds}</tr>`;
  }).join("");
  wrap.innerHTML = `<table class="rollup"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
  wrap.querySelectorAll("tr.trow").forEach(r => {
    r.addEventListener("click", () => openModal(r.dataset.sid, maxTok));
  });
  wrap.querySelectorAll("th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (TABLE_SORT.key === k) TABLE_SORT.dir = -TABLE_SORT.dir;
      else { TABLE_SORT.key = k; TABLE_SORT.dir = -1; }
      renderTable(LAST_DISPLAY, LAST_MAXTOK);
    });
  });
}

// Banner totals (unit-aware) — recomputed on load and on unit toggle.
export function updateBanner() {
  const ss = LAST_SESSIONS || [];
  const tot_in = ss.reduce((s, x) => s + x.total_input, 0);
  const tot_cached = ss.reduce((s, x) => s + x.total_cached, 0);
  const tot_req = ss.reduce((s, x) => s + x.n_requests, 0);
  const tot_aic = ss.reduce((s, x) => s + (x.total_aic || 0), 0);
  const costPart = ss.some(x => x.cost_available) ? ` · ${S.SOURCE === "all" ? "Copilot " : ""}${fmtCost(tot_aic)}` : "";
  document.getElementById("banner-stats").textContent =
    `· ${ss.length} sessions · ${fmt(tot_req)} reqs · ${qtyText(tot_in)} input · ${tot_in ? Math.round(100 * tot_cached / tot_in) : 0}% cached${costPart} · shared y-max ${qtyText(LAST_MAXTOK)}`;
}

// Re-express every cost figure on screen in the active unit (AIC or $).
export function applyUnit() {
  document.querySelectorAll(".unit-btn").forEach(b => b.classList.toggle("active", b.dataset.unit === S.UNIT));
  const calBtn = document.getElementById("calTrigger");
  if (calBtn) calBtn.textContent = `📅 ${calendarButtonLabel()}`;
  updateBanner();
  if (LAST_SESSIONS.length) applyView();
  if (!calPop.hidden) renderCalendar();
  if (S.MODAL_SID) openModal(S.MODAL_SID);
}

export function applySourceControls() {
  S.CAL_COST = hasCostMetric();
  S.CAL_UNIT = S.CAL_COST ? "AIC" : "input tokens";
  document.querySelectorAll(".source-btn").forEach(b => b.classList.toggle("active", b.dataset.source === S.SOURCE));
  const unitToggle = document.getElementById("unitToggle");
  if (unitToggle) unitToggle.hidden = !hasCostMetric();
  const aicSort = document.querySelector('#sort option[value="aic"]');
  if (aicSort) aicSort.textContent = hasCostMetric() ? "by AIC" : "by usage metric";
  const calBtn = document.getElementById("calTrigger");
  if (calBtn) calBtn.textContent = `📅 ${calendarButtonLabel()}`;
}

export function applyView() {
  const charts = S.VIEW !== "table";
  document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", (b.dataset.view === "table") !== charts));
  document.querySelectorAll(".combine-btn").forEach(b => b.classList.toggle("active", (b.dataset.combine === "1") === S.COMBINE));
  document.querySelectorAll(".unit-btn").forEach(b => b.classList.toggle("active", b.dataset.unit === S.UNIT));
  applySourceControls();
  document.getElementById("grid").hidden = !charts;
  document.getElementById("tableWrap").hidden = charts;
  if (!LAST_SESSIONS.length) return;
  LAST_DISPLAY = displaySessions();
  if (charts) renderCards(LAST_DISPLAY, LAST_MAXTOK);
  else renderTable(LAST_DISPLAY, LAST_MAXTOK);
}

document.querySelectorAll(".view-btn").forEach(b => {
  b.addEventListener("click", () => {
    if (S.VIEW === b.dataset.view) return;
    S.VIEW = b.dataset.view;
    syncUrl();
    applyView();
  });
});

document.querySelectorAll(".combine-btn").forEach(b => {
  b.addEventListener("click", () => {
    const v = b.dataset.combine === "1";
    if (S.COMBINE === v) return;
    S.COMBINE = v;
    syncUrl();
    applyView();
  });
});

document.querySelectorAll(".source-btn").forEach(b => {
  b.addEventListener("click", () => {
    if (S.SOURCE === b.dataset.source) return;
    S.SOURCE = b.dataset.source;
    S.CAL_DAYS = {};
    S._calLoaded = false;
    applySourceControls();
    syncUrl();
    loadSessions();
    if (!calPop.hidden) loadCalendar();
  });
});

document.querySelectorAll(".unit-btn").forEach(b => {
  b.addEventListener("click", () => {
    if (S.UNIT === b.dataset.unit) return;
    S.UNIT = b.dataset.unit;
    syncUrl();
    applyUnit();
  });
});

document.getElementById("controls").addEventListener("submit", e => {
  e.preventDefault();
  // Refresh means "show everything on disk right now": re-anchor a pinned
  // ("last N hours") window to now so sessions started since the last load are
  // included. (Sessions are matched by lifetime overlap, so still-active
  // sessions remain visible even in windows whose end is in the past.)
  const [s, en] = getRangeTs();
  if (S.RANGE_PINNED && s && en) {
    const now = Math.floor(Date.now() / 1000);
    setRangeTs(s + (now - en), now);
  }
  loadSessions();
});

// Changing sort/limit/min_tokens reloads immediately so the URL always reflects
// what's on screen (the Refresh button remains the "re-anchor to now" action).
["sort", "limit", "min_tokens"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => loadSessions());
});

// Initial load: restore the full view (range, controls, calendar, open modal) from the URL.
