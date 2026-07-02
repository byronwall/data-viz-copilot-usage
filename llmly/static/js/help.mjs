import { S } from "./state.mjs";
import { escapeHtml, niceCeil } from "./format.mjs";
import { renderChart } from "./chart.mjs";
import { renderDetail } from "./detail.mjs";
import { wireDetailViews, wireExpand, wireFileRows, wireHeatExpand, wireRfViews, wireSortable, wireToolAgg, wireToolTabs } from "./chart-select.mjs";
import { syncUrl } from "./url-state.mjs";

// ---------- Help / guided tour ----------
// A self-contained demo session (one main agent + one sub-agent + one 🔍 search-subagent),
// rendered with the real renderChart/renderDetail so the explanation always matches the UI.
// Fixed timestamps keep the demo deterministic.
export const DEMO_END_TS = new Date("2026-06-04T14:32:00").getTime();
export function _demoTool(n, a, res, d) { return { n, a, res: res || "", d: d || 0, s: "success", t: 0 }; }

export function buildDemoPayload() {
  const main = [
    { t: 0, input: 2000, cached: 0, output: 420, dbg: "panel/editAgent", reasoning: "medium", aic: 0.6,
      tools: [_demoTool("user_message", "Add JWT auth to the API and write tests for the middleware"),
              _demoTool("readFile", '{"filePath":"src/server.ts"}', "import express from 'express'\nconst app = express()\n// ...route registration", 11)] },
    { t: 42000, input: 7600, cached: 1800, output: 610, dbg: "panel/editAgent", reasoning: "medium", aic: 1.8,
      tools: [_demoTool("readFile", '{"filePath":"src/routes/api.ts"}', "router.get('/users', listUsers)\nrouter.post('/users', createUser)", 9),
              _demoTool("apply_patch", '{"filePath":"src/middleware/auth.ts"}', "Applying patch failed with error: Invalid context at character 0: the patch did not match the file contents", 6),
              _demoTool("editFile", '{"filePath":"src/middleware/auth.ts"}', "+ export function requireAuth(req, res, next) { ... }", 34)] },
    { t: 118000, input: 16800, cached: 9200, output: 880, dbg: "panel/editAgent", reasoning: "high", aic: 4.2,
      tools: [_demoTool("runInTerminal", '{"command":"npm test"}', "Tests:  3 passed, 2 failed\n  ✕ rejects expired tokens", 2400)] },
    { t: 178000, input: 28000, cached: 0, output: 0, dbg: "compaction", reasoning: "", compact: true, aic: 2.1, tools: [] },
    { t: 236000, input: 11200, cached: 8400, output: 540, dbg: "panel/editAgent", reasoning: "medium", aic: 2.0,
      tools: [_demoTool("editFile", '{"filePath":"test/auth.test.ts"}', "+ 4 new cases covering expiry & malformed tokens", 18)] },
    { t: 318000, input: 14600, cached: 12100, output: 720, dbg: "panel/editAgent", reasoning: "medium", aic: 2.8,
      tools: [_demoTool("runInTerminal", '{"command":"npm test"}', "Tests:  9 passed, 0 failed", 2100)] },
  ];
  // cumulative input for the main line
  let cum = 0;
  main.forEach((c, i) => { cum += c.input; c.cum = cum; c.idx = i; c.err = false; c.user = (c.tools || []).some(t => t.n === "user_message"); });

  const kid1Calls = [
    { t: 94000, input: 4800, cached: 0, output: 300, dbg: "subagent", reasoning: "low", aic: 1.1,
      tools: [_demoTool("user_message", "Locate the auth middleware and the User model"), _demoTool("grepSearch", '{"query":"requireAuth|User model"}', "5 matches across 3 files", 40)] },
    { t: 138000, input: 8600, cached: 3900, output: 410, dbg: "subagent", reasoning: "low", aic: 1.9,
      tools: [_demoTool("readFile", '{"filePath":"src/models/user.ts"}', "export interface User { id, email, hash }", 8)] },
    { t: 172000, input: 6400, cached: 4700, output: 220, dbg: "subagent", reasoning: "low", aic: 1.4, tools: [] },
  ];
  const kid2Calls = [
    { t: 204000, input: 3800, cached: 0, output: 260, dbg: "searchSubagentTool", reasoning: "minimal", aic: 0.9,
      tools: [_demoTool("user_message", "Find existing error-handling patterns in the codebase"), _demoTool("semanticSearch", '{"query":"error handling middleware express"}', "3 relevant files", 120)] },
    { t: 232000, input: 5600, cached: 2900, output: 340, dbg: "searchSubagentTool", reasoning: "minimal", aic: 1.3, tools: [] },
  ];
  [kid1Calls, kid2Calls].forEach(cl => { let c = 0; cl.forEach((x, i) => { c += x.input; x.cum_offset = c; x.idx = i; x.err = false; x.user = (x.tools || []).some(t => t.n === "user_message"); }); });

  const all = main.concat(kid1Calls, kid2Calls);
  const sum = f => all.reduce((s, c) => s + (f(c) || 0), 0);
  return {
    sid: "demo-9c1f4a2b", workspace: "my-app", mtime: DEMO_END_TS / 1000, last_event_ts: DEMO_END_TS,
    first_user: "Add JWT auth to the API and write tests for the middleware",
    top_model: "claude-sonnet-4-6", reasoning: "medium", parent_sid: null, duration_ms: 318000,
    total_input: sum(c => c.input), total_cached: sum(c => c.cached), total_output: sum(c => c.output),
    total_aic: sum(c => c.aic), n_compactions: 1, n_requests: all.length,
    main,
    kids: [
      { label: "explore-codebase: locate auth & user model", start_t: 88000, start_tok: 0,
        is_search_child: false, child_sid: null, top_model: "claude-sonnet-4-6", calls: kid1Calls },
      { label: "🔍 search: existing error-handling patterns", start_t: 198000, start_tok: 0,
        is_search_child: true, child_sid: "demo-search-3e7d", top_model: "claude-haiku-4-5", calls: kid2Calls },
    ],
  };
}

// Pins are placed in the chart's own 720×540 coordinate space (the demo svg is rendered
// at exactly that pixel size), so positions line up with the rendered features.
export const HELP_PINS = [
  { n: 1, x: 430, y: 13, title: "Usage summary", body: "Date · total input tokens · cache hit % · available session cost. Copilot-only cost shows in AIC credits or $." },
  { n: 2, x: 240, y: 32, title: "Turn structure", body: "Request count, <b>sub</b>-agents, <b>🔍</b> search-subagents, and <b>◆</b> compactions for this session." },
  { n: 3, x: 470, y: 150, title: "Foreground line", body: "Cumulative input tokens for the main agent. Steeper = tokens piling up fast (often a large or uncached turn)." },
  { n: 4, x: 297, y: 289, title: "Dot = one request", body: "Dot <b>size</b> ∝ that turn's input; dot <b>color</b> = cache hit rate (blue warm → amber → red cold)." },
  { n: 5, x: 335, y: 331, title: "Sub-agent (dashed)", body: "A spawned sub-agent gets its own dashed line and color, tracking its own running token total." },
  { n: 6, x: 516, y: 344, title: "🔍 Search-subagent", body: "Search sub-agents are blue & dashed; the small ring marks where it was spawned. Click through to its own session." },
  { n: 7, x: 380, y: 172, title: "◆ Compaction", body: "An orange diamond marks where the context was summarized to free up tokens — note the jump in cumulative input." },
  { n: 8, x: 300, y: 446, title: "Per-turn input band", body: "The lower band shows each turn's input in isolation (not cumulative), so you can spot the spikes that drove cost." },
  { n: 9, x: 251, y: 358, title: "⭐ User message", body: "A gold star marks a turn the <b>human kicked off</b> by typing a prompt. Stars are drawn on top of every other marker so the human's inputs always stand out — scan them to see the back-and-forth that shaped the session." },
];

export const HELP_FEATURES = [
  { name: "Date range", key: "◀ ▶", desc: "Set an explicit start/end, or step the window backward/forward by its current span." },
  { name: "Quick ranges", key: "1h–90d", desc: "Jump to the last N hours/days ending now. Refresh re-anchors a quick range to the current time." },
  { name: "Usage calendar", key: "📅", desc: "A year heatmap of daily usage. Click a day to filter to it; Copilot-only mode can switch between AIC and $." },
  { name: "Sort & limit", desc: "Order sessions by input, cost, recency, requests, or duration. Top-N and a min-token floor trim the list." },
  { name: "Charts ↔ Table", desc: "Same sessions as SVG small-multiples or a sortable rollup table. Click a column header to re-sort the table." },
  { name: "Combine sub-agents", desc: "Fold sub-agent tokens into their parent (default), or split each sub-agent out as its own independent row/card." },
  { name: "AIC ↔ $", desc: "In Copilot-only mode, show cost as AIC credits or US dollars at the fixed 100 AIC = $1 rate." },
  { name: "Detail modal", desc: "Click a card/row to open per-turn detail. Click a chart dot or table row to highlight the matching turn." },
  { name: "Shareable URL", desc: "Every control, the open calendar, the open session, and the detail-view toggles (turns / by tool / by file, tabs, heatmaps) are encoded in the URL — copy it to share the exact view; the toggles also carry over to the next session you open." },
];

export const HELP_COLORS = [
  { mark: `<span class="hc-star"></span>`, txt: "<b>⭐ User message</b> — a human prompt; gold star, always drawn on top" },
  { mark: `<span class="hc-swatch" style="background:#58a6ff"></span>`, txt: "<b>Foreground</b> agent (panel/editAgent) — solid line" },
  { mark: `<span class="hc-line" style="border-color:#a371f7"></span>`, txt: "<b>Sub-agent</b> — dashed, one color each" },
  { mark: `<span class="hc-line" style="border-color:#79c0ff;border-top-style:dashed"></span>`, txt: "<b>🔍 search-subagent</b> — dashed blue + spawn ring" },
  { mark: `<span class="fail-icon">⚠</span>`, txt: "<b>Failed tool call</b> — the operation errored (e.g. a patch that didn't apply); orange-tinted, with a ⚠ and a per-tool fail count in the by-tool/by-file rollups" },
  { mark: `<span class="hc-dia"></span>`, txt: "<b>Compaction</b> — context was summarized" },
  { mark: `<span class="hc-swatch" style="background:#58a6ff"></span>`, txt: "<b>Warm cache</b> — &gt;70% of input was cached" },
  { mark: `<span class="hc-swatch" style="background:#d29922"></span>`, txt: "<b>Medium cache</b> — 30–70% cached" },
  { mark: `<span class="hc-swatch" style="background:#f85149"></span>`, txt: "<b>Cold cache</b> — &lt;30% cached (most expensive)" },
  { mark: `<span class="rsn" style="--rc:#d29922">med</span>`, txt: "<b>Reasoning effort</b> pill — requested level, not a token count" },
];


export function renderHelp() {
  const payload = buildDemoPayload();

  // Annotated chart (rendered at native 720×540 so pins align).
  const chart = document.getElementById("helpChart");
  let sessionPeak = 0;
  for (const c of payload.main) if (c.cum > sessionPeak) sessionPeak = c.cum;
  for (const k of payload.kids) for (const c of k.calls) if (c.cum_offset > sessionPeak) sessionPeak = c.cum_offset;
  chart.innerHTML = renderChart(payload, { w: 720, h: 540, maxTok: niceCeil(sessionPeak || 1000), big: true });
  chart.querySelectorAll(".help-pin").forEach(p => p.remove());
  for (const p of HELP_PINS) {
    const pin = document.createElement("div");
    pin.className = "help-pin"; pin.dataset.n = p.n; pin.textContent = p.n;
    pin.style.left = p.x + "px"; pin.style.top = p.y + "px";
    pin.title = p.title;
    chart.appendChild(pin);
  }

  // Numbered legend, hover-linked to the pins both ways.
  const list = document.getElementById("helpPinsList");
  list.innerHTML = HELP_PINS.map(p =>
    `<li data-n="${p.n}"><span class="pin-n">${p.n}</span><span class="pin-txt"><b>${escapeHtml(p.title)}</b> — ${p.body}</span></li>`
  ).join("");
  const setActive = (n, on) => {
    chart.querySelector(`.help-pin[data-n="${n}"]`)?.classList.toggle("active", on);
    list.querySelector(`li[data-n="${n}"]`)?.classList.toggle("active", on);
  };
  list.querySelectorAll("li").forEach(li => {
    li.addEventListener("mouseenter", () => setActive(li.dataset.n, true));
    li.addEventListener("mouseleave", () => setActive(li.dataset.n, false));
  });
  chart.querySelectorAll(".help-pin").forEach(pin => {
    pin.addEventListener("mouseenter", () => setActive(pin.dataset.n, true));
    pin.addEventListener("mouseleave", () => setActive(pin.dataset.n, false));
  });

  // Live detail table — reuse the real renderer + interactions.
  const detail = document.getElementById("helpDetail");
  detail.innerHTML = renderDetail(payload);
  wireExpand(detail);
  wireDetailViews(detail);
  wireToolAgg(detail);
  wireToolTabs(detail);
  wireRfViews(detail);
  wireHeatExpand(detail);
  wireFileRows(detail);
  detail.querySelectorAll("table.tagg-files").forEach(wireSortable);

  // Static reference cards.
  document.getElementById("helpFeatures").innerHTML = HELP_FEATURES.map(f =>
    `<div class="help-feature"><div class="hf-name">${escapeHtml(f.name)}${f.key ? `<span class="hf-key">${escapeHtml(f.key)}</span>` : ""}</div><div class="hf-desc">${f.desc}</div></div>`
  ).join("");
  document.getElementById("helpColors").innerHTML = HELP_COLORS.map(c =>
    `<div class="help-color"><span class="hc-mark">${c.mark}</span><span class="hc-txt">${c.txt}</span></div>`
  ).join("");
}

export function openHelp() {
  if (S.HELP_OPEN) return;
  S.HELP_OPEN = true;
  renderHelp();
  document.getElementById("helpModal").classList.add("open");
  syncUrl(true);
}
export function closeHelp() {
  if (!S.HELP_OPEN) return;
  S.HELP_OPEN = false;
  document.getElementById("helpModal").classList.remove("open");
  syncUrl(true);
}
document.getElementById("helpBtn").addEventListener("click", openHelp);
document.getElementById("helpCloseBtn").addEventListener("click", closeHelp);
document.getElementById("helpModal").addEventListener("click", e => { if (e.target.id === "helpModal") closeHelp(); });

