import { PALETTE, costColumnLabel, escapeHtml, fmt, fmtAic, hms, qty, qtyText, summarizeArgs } from "./format.mjs";
import { toolBlockHtml, toolFailReason, toolFailed } from "./detail.mjs";
import { toolFilePaths } from "./file-agg.mjs";

// ---------- "By tool" aggregate view ----------
// Rolls token usage up by the tool a request invoked. "new input" is each request's
// input delta vs. the previous request in the SAME agent (foreground or a given
// sub-agent), since each agent grows its own context. A request's metrics are
// attributed to every distinct tool it called, so a request that invokes several
// tools is counted under each — column totals can therefore exceed the (honest)
// session totals shown above the table. Requests with no tools fall into a
// "(no tool call)" bucket so compactions and the like are still accounted for.
export const NO_TOOL = "(no tool call)";

export function computeToolAgg(payload) {
  const groups = [{ label: "foreground", calls: payload.main || [] }];
  (payload.kids || []).forEach((k, ki) => {
    const label = k.is_search_child
      ? `🔍 search-subagent ${k.child_sid ? k.child_sid.slice(0, 8) : ""}`
      : `sub-agent: ${k.label || ("K" + ki)}`;
    groups.push({ label, calls: k.calls || [] });
  });

  const buckets = new Map(); // tool name -> bucket
  function bucketFor(name) {
    let b = buckets.get(name);
    if (!b) { b = { name, callers: new Map(), sumNew: 0, sumUncached: 0, sumOut: 0, sumAic: 0, uses: 0, fails: 0 }; buckets.set(name, b); }
    return b;
  }

  let totalNew = 0, totalUncached = 0;
  groups.forEach(g => {
    let prevInput = null;
    g.calls.forEach(c => {
      const input = c.input || 0;
      // Delta vs. the previous request in this agent. Clamp at 0: a request that
      // shrank the context (e.g. right after a compaction) added no new input — the
      // compaction's own big input lands in the (no tool call) bucket instead.
      const newInput = prevInput == null ? input : Math.max(0, input - prevInput);
      prevInput = input;
      totalNew += newInput;
      const uncached = Math.max(0, input - (c.cached || 0));
      totalUncached += uncached;

      const tools = c.tools || [];
      const callKey = `${g.label}#${c.idx}`;
      const meta = {
        key: callKey, t: c.t, dbg: c.dbg, grp: g.label,
        compact: !!c.compact, err: !!c.err, errMsg: c.err_msg || "",
        newInput, uncached, out: c.output || 0, aic: c.aic || 0,
      };
      const names = tools.length ? [...new Set(tools.map(t => t.n || "?"))] : [NO_TOOL];
      names.forEach(nm => {
        const b = bucketFor(nm);
        let caller = b.callers.get(callKey);
        if (!caller) {
          caller = { ...meta, instances: [], fails: 0 };
          b.callers.set(callKey, caller);
          b.sumNew += meta.newInput; b.sumUncached += meta.uncached; b.sumOut += meta.out; b.sumAic += meta.aic;
        }
        if (nm === NO_TOOL) { b.uses += 1; return; }
        const insts = tools.filter(t => (t.n || "?") === nm);
        insts.forEach(t => { caller.instances.push(t); b.uses += 1; if (toolFailed(t)) { b.fails += 1; caller.fails += 1; } });
      });
    });
  });

  const list = [...buckets.values()].map(b => ({
    name: b.name,
    nCallers: b.callers.size,
    uses: b.uses,
    fails: b.fails,
    sumNew: b.sumNew, sumUncached: b.sumUncached, sumOut: b.sumOut, sumAic: b.sumAic,
    callers: [...b.callers.values()].sort((a, z) => z.aic - a.aic),
  })).sort((a, z) => z.sumAic - a.sumAic);

  const totalAic = payload.total_aic != null ? payload.total_aic : list.reduce((s, b) => s + b.sumAic, 0);
  const totalFails = list.reduce((s, b) => s + b.fails, 0);
  return { list, totalNew, totalUncached, totalOut: payload.total_output || 0, totalAic, totalFails };
}

// Single-file path keys, across tools/agents: Copilot (filePath/relativePath),
// Codex (path), Claude (file_path/notebook_path), plus other common spellings.
export const SINGLE_PATH_KEYS = ["filePath", "file_path", "path", "file", "target_file",
  "absolute_path", "relativePath", "notebook_path"];

export function pickPathKey(o) {
  for (const k of SINGLE_PATH_KEYS) {
    if (o[k]) return String(o[k]);
  }
  return "";
}

// Pull a file path out of a tool's args JSON, trying the keys various tools use.
export function toolFilePath(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] === "{") {
    try {
      return pickPathKey(JSON.parse(s));
    } catch (_) { /* not json */ }
  }
  return "";
}

// A short "what part of the file" hint from read args (line range / offset+limit).
export function fileRange(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] === "{") {
    try {
      const o = JSON.parse(s);
      if (o.startLine != null || o.endLine != null) return `L${o.startLine ?? ""}–${o.endLine ?? ""}`;
      if (o.offset != null || o.limit != null) return `@${o.offset ?? 0}${o.limit != null ? ` +${o.limit}` : ""}`;
    } catch (_) { /* ignore */ }
  }
  return "";
}
// Numeric [start,end] line span from read args (for the line heatmap), or null.
export function parseRange(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] === "{") {
    try {
      const o = JSON.parse(s);
      let a, b;
      if (o.startLine != null || o.endLine != null) { a = +o.startLine || 1; b = +o.endLine || a; }
      else if (o.offset != null || o.limit != null) { a = (+o.offset || 0) + 1; b = a + (+o.limit || 0); }
      else return null;
      a = Math.max(1, a); b = Math.max(a, b);
      return { start: a, end: b };
    } catch (_) { /* ignore */ }
  }
  return null;
}
// Heat color by read count: first read cool (blue), heating through green/yellow/orange
// to red as the same lines get re-read. 0 = unread (faint track).
export const HEAT_SCALE = ["#1f6feb", "#2f9e44", "#e3b341", "#f0883e", "#f85149"];
export function heatColor(n) {
  if (n <= 0) return "#161b22";
  return HEAT_SCALE[Math.min(n, HEAT_SCALE.length) - 1];
}
// Build a stretched SVG strip across a file's line range; each segment colored by how
// many of the reads covered it. Returns the svg plus the file's max line and peak overlap.
export function lineHeatStrip(spans, fixedMax) {
  const maxLine = Math.max(1, fixedMax || Math.max(1, ...spans.map(s => s.end)));
  const N = Math.min(240, Math.max(1, maxLine));
  const lpb = maxLine / N;
  const counts = new Array(N).fill(0);
  spans.forEach(s => {
    const a = Math.max(0, Math.floor((s.start - 1) / lpb));
    const b = Math.min(N - 1, Math.floor((s.end - 1) / lpb));
    for (let i = a; i <= b; i++) counts[i]++;
  });
  const maxC = Math.max(1, ...counts);
  let rects = "";
  for (let i = 0; i < N; i++) {
    const c = counts[i];
    const lo = Math.floor(i * lpb) + 1, hi = Math.min(maxLine, Math.floor((i + 1) * lpb));
    const title = c > 0 ? `<title>L${lo}–${hi}: ${c}×</title>` : "";
    rects += `<rect x="${i}" y="0" width="1.02" height="12" fill="${heatColor(c)}">${title}</rect>`;
  }
  return { svg: `<svg class="heat-svg" viewBox="0 0 ${N} 12" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`, maxLine, maxC };
}

// Guess the working root (e.g. the worktree). Rather than the longest common prefix —
// which a handful of out-of-tree reads (system files, the VS Code cache) drag up to
// something useless like /Users/name — we score every candidate ancestor directory by
// coverage × depth and take the best. That favors the deepest directory that still holds
// most files: the worktree wins, while the stray system reads stay outside it.
export function guessRoot(paths) {
  const norm = paths.filter(Boolean).map(p => p.replace(/\\/g, "/"));
  if (!norm.length) return "";
  const total = norm.length;
  const count = new Map(); // ancestor dir -> # files under it
  for (const p of norm) {
    const segs = p.split("/");
    let acc = "";
    for (let i = 0; i < segs.length - 1; i++) { // ancestors only, exclude the filename
      acc = i === 0 ? segs[0] : acc + "/" + segs[i];
      count.set(acc, (count.get(acc) || 0) + 1);
    }
  }
  let best = "", bestScore = 0, bestDepth = 0;
  for (const [prefix, n] of count) {
    const depth = prefix.split("/").filter(Boolean).length;
    if (!depth) continue; // ignore filesystem root "/"
    const score = (n / total) * depth;
    if (score > bestScore || (score === bestScore && depth > bestDepth)) {
      best = prefix; bestScore = score; bestDepth = depth;
    }
  }
  return best;
}
export function underRoot(root, p) {
  p = String(p ?? "").replace(/\\/g, "/");
  return !!root && (p === root || p.startsWith(root + "/"));
}
export function relTo(root, p) {
  p = String(p ?? "").replace(/\\/g, "/");
  return underRoot(root, p) ? p.slice(root.length).replace(/^\//, "") : p;
}

// Flatten a bucket's callers into one event per tool invocation (inst), carrying the
// owning request's metadata. Callers with no instances (e.g. compactions) yield one
// inst-less event so they still appear.
export function bucketEvents(bucket) {
  const events = [];
  bucket.callers.forEach(c => {
    const base = { aic: c.aic, grp: c.grp, dbg: c.dbg, newInput: c.newInput, uncached: c.uncached, callT: c.t };
    if (c.instances.length) c.instances.forEach(inst => events.push({ ...base, t: inst.t != null ? inst.t : c.t, inst }));
    else events.push({ ...base, t: c.t, inst: null });
  });
  return events;
}

// Hover disclosure for the "×N" reads badge: a list of every read of that file with a
// timestamp, line range and result size, so a high count can be inspected call-by-call.
export function readsPopover(rel, calls) {
  const rows = calls.map((c, i) =>
    `<tr><td class="num">${i + 1}</td><td>${hms(c.t)}</td><td class="rng">${escapeHtml(c.range || "full")}</td><td class="num">${c.resLen ? qtyText(c.resLen) + "c" : "—"}</td><td class="num">${c.dur ? c.dur + "ms" : ""}</td></tr>`
  ).join("");
  return `<span class="rcount-pop"><span class="rcp-head">${calls.length} reads of <b>${escapeHtml(rel)}</b></span>`
    + `<table class="rcp-tbl"><thead><tr><th class="num">#</th><th>time</th><th>range</th><th class="num">result</th><th class="num">dur</th></tr></thead><tbody>${rows}</tbody></table></span>`;
}

// Stable short agent identifier from a list of events, ordered by first-seen.
// Foreground gets "main"; 🔍 search sub-agents get "search N"; others get "sub N".
export function stableAgentIdent(events) {
  const firstT = new Map();
  events.forEach(e => { if (!firstT.has(e.grp)) firstT.set(e.grp, e.t || 0); });
  const grps = [...firstT.keys()].sort((a, z) =>
    a === "foreground" ? -1 : z === "foreground" ? 1 : firstT.get(a) - firstT.get(z));
  const map = new Map();
  let subIdx = 0, searchIdx = 0;
  grps.forEach(grp => {
    if (grp === "foreground") map.set(grp, { color: "#58a6ff", icon: "■", short: "main" });
    else if (grp.startsWith("🔍")) map.set(grp, { color: "#79c0ff", icon: "🔍", short: `search ${++searchIdx}` });
    else map.set(grp, { color: PALETTE[subIdx % PALETTE.length], icon: "◆", short: `sub ${++subIdx}` });
  });
  return map;
}

// Render a compact agent badge: colored swatch + short id, full grp on hover.
export function agentBadgeHtml(id, grp) {
  if (!id) return `<span class="grp" title="${escapeHtml(grp || "")}">${escapeHtml(grp || "")}</span>`;
  return `<span class="agent-badge" title="${escapeHtml(grp || "")}"><i class="agent-swatch" style="background:${id.color}">${id.icon}</i><span class="agent-short">${escapeHtml(id.short)}</span></span>`;
}

// Dedicated read_file view: every read as a row, paths shown relative to a guessed
// root, sortable by name or time, each row expanding to full args + result.
export function buildFilePanel(bucket, ul) {
  const events = bucketEvents(bucket);
  const paths = events.map(e => toolFilePath(e.inst && e.inst.a));
  const root = guessRoot(paths.filter(Boolean));
  const rels = paths.map(p => p ? relTo(root, p) : "");
  const counts = {};
  const fileCalls = {}; // rel -> [{t, range, resLen, dur}] across all its reads, time-ordered
  events.forEach((e, i) => {
    const r = rels[i];
    if (!r) return;
    counts[r] = (counts[r] || 0) + 1;
    const inst = e.inst;
    (fileCalls[r] = fileCalls[r] || []).push({
      t: e.t || 0, range: inst ? fileRange(inst.a) : "",
      resLen: inst && inst.res ? inst.res.length : 0, dur: inst ? (inst.d || 0) : 0,
    });
  });
  Object.values(fileCalls).forEach(a => a.sort((x, y) => x.t - y.t));
  const outside = paths.filter(p => p && !underRoot(root, p)).length;
  const order = events.map((_, i) => i).sort((a, z) => (events[a].t || 0) - (events[z].t || 0));
  // per-read records (carry the agent) for the line heatmap, grouped by agent there.
  const reads = events.map((e, i) => ({ rel: rels[i], path: paths[i] || "", grp: e.grp, t: e.t || 0, span: e.inst ? parseRange(e.inst.a) : null })).filter(r => r.rel);
  const ident = stableAgentIdent(events);

  let h = `<div class="tagg-file-head"><span>root <code>${root ? escapeHtml(root) : "—"}</code></span><span><b>${Object.keys(counts).length}</b> files · <b>${events.length}</b> reads${outside ? ` · <b>${outside}</b> outside root <span class="muted">(full path)</span>` : ""}</span></div>`;
  h += `<div class="view-toggle rf-toggle">
    <button type="button" class="rf-btn active" data-rfview="table">table</button>
    <button type="button" class="rf-btn" data-rfview="heatmap">line heatmap</button>
  </div>`;
  h += `<div class="rf-view" data-rfview="table"><div class="tagg-file-sub muted">click a row for full args &amp; result · click a ↕ header to sort</div>`;
  h += `<table class="tagg-files"><colgroup><col class="c-num"><col class="c-time"><col class="c-file"><col class="c-reads"><col class="c-range"><col class="c-res"><col class="c-dur"><col class="c-src"><col class="c-aic"></colgroup><thead><tr>
    <th class="num" data-sort="ord" data-sort-type="num">#</th>
    <th data-sort="t" data-sort-type="num">time</th>
    <th data-sort="file" data-sort-type="str">file</th>
    <th class="num" data-sort="reads" data-sort-type="num">reads</th>
    <th data-sort="range" data-sort-type="str">range</th>
    <th class="num" data-sort="res" data-sort-type="num">result</th>
    <th class="num" data-sort="dur" data-sort-type="num">dur</th>
    <th data-sort="src" data-sort-type="str">source</th>
    <th class="num" data-sort="aic" data-sort-type="num">${ul}</th>
  </tr></thead><tbody>`;
  order.forEach((ei, ord) => {
    const e = events[ei], inst = e.inst;
    const rel = rels[ei] || "(no path)";
    const ext = paths[ei] && !underRoot(root, paths[ei]);
    const cnt = rels[ei] ? counts[rels[ei]] : 0;
    const range = inst ? fileRange(inst.a) : "";
    const resLen = inst && inst.res ? inst.res.length : 0;
    const dur = inst ? (inst.d || 0) : 0;
    const exp = inst ? " expandable" : "";
    const fail = inst ? toolFailReason(inst) : "";
    const id = ident.get(e.grp);
    const srcKey = (id ? id.short : e.grp || "") + " " + (e.dbg || "");
    h += `<tr class="srow${exp}${fail ? " srow-failed" : ""}" data-ord="${ord}" data-t="${e.t || 0}" data-file="${escapeHtml(rel.toLowerCase())}" data-path="${escapeHtml((paths[ei] || rel).toLowerCase())}" data-reads="${cnt || 0}" data-range="${escapeHtml(range.toLowerCase())}" data-res="${resLen}" data-dur="${dur}" data-src="${escapeHtml(srcKey.toLowerCase())}" data-aic="${e.aic || 0}">
      <td class="num">${ord + 1}</td>
      <td>${hms(e.t || 0)}</td>
      <td>${inst ? `<span class="caret">▸</span>` : ""}${fail ? `<span class="fail-icon" title="failed: ${escapeHtml(fail)}">⚠</span> ` : ""}<span class="fpath${ext ? " ext" : ""}" title="${escapeHtml(paths[ei] || "")}">${ext ? "↗ " : ""}${escapeHtml(rel)}</span></td>
      <td class="num">${cnt > 1 ? `<span class="rcount">×${cnt}${readsPopover(rels[ei], fileCalls[rels[ei]])}</span>` : (cnt || "")}</td>
      <td class="frange">${escapeHtml(range)}</td>
      <td class="num">${resLen ? qtyText(resLen) + "c" : "<span style='color:#444'>—</span>"}</td>
      <td class="num">${dur ? dur + "ms" : ""}</td>
      <td class="dbg">${agentBadgeHtml(id, e.grp)}${e.dbg ? ` <span class="dbgn">${escapeHtml(e.dbg)}</span>` : ""}</td>
      <td class="num aic">${e.aic ? fmtAic(e.aic) : "<span style='color:#444'>—</span>"}</td>
    </tr>`;
    if (inst) h += `<tr class="srow-detail collapsed"><td colspan="9"><div class="tools-inner">${toolBlockHtml(inst)}</div></td></tr>`;
  });
  h += `</tbody></table></div>`;
  h += `<div class="rf-view" data-rfview="heatmap" hidden>${buildLineHeatmap(reads)}</div>`;
  return h;
}

// Stable per-agent identity (color + icon) for the heatmap. Foreground and 🔍 search
// sub-agents get fixed marks; other sub-agents cycle the palette in first-seen order so
// the same agent keeps the same color/icon throughout the view.
export function agentIdentity(grps) {
  const map = new Map();
  let subIdx = 0;
  grps.forEach(grp => {
    if (map.has(grp)) return;
    if (grp === "foreground") map.set(grp, { color: "#58a6ff", icon: "■", short: "main" });
    else if (grp.startsWith("🔍")) map.set(grp, { color: "#79c0ff", icon: "🔍", short: "search" });
    else map.set(grp, { color: PALETTE[subIdx % PALETTE.length], icon: "◆", short: `sub ${++subIdx}` });
  });
  return map;
}

export function heatStripHtml(svg, maxLine) {
  return `<div class="heat-strip"><span class="heat-ax">1</span>${svg}<span class="heat-ax">${fmt(maxLine)}</span></div>`;
}

// Per-file line-coverage heatmap. Condensed by default: one combined strip per file
// (all agents merged). Files read by more than one agent are expandable — click to
// reveal a per-agent split (aligned to the same line scale), click again to collapse.
// A stable colored icon IDs each agent (swatches on the condensed row, full label in
// the split). Files are ordered by total read count (hottest first).
export function buildLineHeatmap(reads) {
  const legend = HEAT_SCALE.map((c, i) => `<span class="heat-key"><i style="background:${c}"></i>${i + 1 === HEAT_SCALE.length ? `${i + 1}+` : i + 1}×</span>`).join("");
  let h = `<div class="heat-legend"><span class="muted">reads per line — cool→hot as the same lines are re-read · hover a band for its range · click a multi-agent file to split by agent</span><span class="heat-keys"><i style="background:${heatColor(0)};outline:1px solid #30363d"></i>unread ${legend}</span></div>`;
  if (!reads.length) { h += `<div class="tagg-file-sub muted" style="padding:16px 12px">No reads to chart.</div>`; return h; }

  // stable agent identity/order across the whole panel
  const byGrpAll = new Map();
  reads.forEach(r => { if (!byGrpAll.has(r.grp)) byGrpAll.set(r.grp, []); byGrpAll.get(r.grp).push(r); });
  const firstT = grp => Math.min(...byGrpAll.get(grp).map(r => r.t));
  const grpsOrdered = [...byGrpAll.keys()].sort((a, z) =>
    a === "foreground" ? -1 : z === "foreground" ? 1 : firstT(a) - firstT(z));
  const ident = agentIdentity(grpsOrdered);

  // per-file aggregation (combined + per-agent)
  const fileMap = new Map();
  reads.forEach(r => {
    let f = fileMap.get(r.rel);
    if (!f) { f = { rel: r.rel, path: r.path || r.rel, reads: 0, spans: [], byAgent: new Map() }; fileMap.set(r.rel, f); }
    f.reads++; if (r.span) f.spans.push(r.span);
    let a = f.byAgent.get(r.grp);
    if (!a) { a = { reads: 0, spans: [] }; f.byAgent.set(r.grp, a); }
    a.reads++; if (r.span) a.spans.push(r.span);
  });
  const files = [...fileMap.values()].sort((a, z) => z.reads - a.reads || z.byAgent.size - a.byAgent.size);
  const withSpans = files.filter(f => f.spans.length);
  const noSpans = files.filter(f => !f.spans.length);
  if (!withSpans.length) h += `<div class="tagg-file-sub muted" style="padding:16px 12px">No line-range info recorded for these reads.</div>`;

  withSpans.forEach((f, fi) => {
    const agents = grpsOrdered.filter(g => f.byAgent.has(g));
    const expandable = agents.length > 1;
    const { svg, maxLine, maxC } = lineHeatStrip(f.spans);
    const swatches = agents.slice(0, 6).map(g => {
      const id = ident.get(g);
      return `<i class="heat-swatch" style="background:${id.color}" title="${escapeHtml(g)}">${id.icon}</i>`;
    }).join("") + (agents.length > 6 ? `<span class="muted heat-more">+${agents.length - 6}</span>` : "");

    h += `<div class="heat-file${expandable ? " expandable" : ""}" data-hf="${fi}" data-path="${escapeHtml((f.path || f.rel).toLowerCase())}">
      <div class="heat-meta">
        <span class="heat-left">${expandable ? `<span class="caret">▸</span>` : `<span class="caret-sp"></span>`}<span class="heat-agents">${swatches}</span><span class="fpath" title="${escapeHtml(f.rel)}">${escapeHtml(f.rel)}</span></span>
        <span class="heat-stat"><b>${f.reads}</b> reads${expandable ? ` · <b>${agents.length}</b> agents` : ""} · ${fmt(maxLine)} lines · peak <b style="color:${heatColor(maxC)}">${maxC}×</b></span>
      </div>
      ${heatStripHtml(svg, maxLine)}
    </div>`;

    if (expandable) {
      h += `<div class="heat-split collapsed">`;
      agents.forEach(g => {
        const a = f.byAgent.get(g), id = ident.get(g);
        const meta = `<div class="heat-submeta"><span class="heat-agent-icon" title="${escapeHtml(id.short)}">${id.icon}</span><span class="heat-agent-label" title="${escapeHtml(g)}">${escapeHtml(g)}</span><span class="muted"><b>${a.reads}</b> reads${a.spans.length ? ` · peak ${lineHeatStrip(a.spans, maxLine).maxC}×` : ""}</span></div>`;
        const strip = a.spans.length ? heatStripHtml(lineHeatStrip(a.spans, maxLine).svg, maxLine) : `<div class="tagg-file-sub muted">whole-file reads (no line range)</div>`;
        h += `<div class="heat-subrow" style="--ac:${id.color}">${meta}${strip}</div>`;
      });
      h += `</div>`;
    }
  });
  if (noSpans.length) h += `<div class="tagg-file-sub muted" style="padding:8px 12px">${noSpans.length} whole-file read(s) without line ranges: ${escapeHtml(noSpans.slice(0, 8).map(f => f.rel).join(", "))}${noSpans.length > 8 ? "…" : ""}</div>`;
  return h;
}

// Generic per-tool view for everything that isn't read_file: one row per invocation,
// arg gist + result size, sortable by gist or time, expandable to full detail.
export function buildGenericPanel(bucket, ul) {
  const events = bucketEvents(bucket);
  const order = events.map((_, i) => i).sort((a, z) => (events[a].t || 0) - (events[z].t || 0));
  const ident = stableAgentIdent(events);
  let h = `<div class="tagg-file-head"><span><b>${events.length}</b> calls</span><span class="muted">click a row for full args &amp; result · click a ↕ header to sort</span></div>`;
  h += `<table class="tagg-files"><colgroup><col class="c-num"><col class="c-time"><col class="c-file"><col class="c-res"><col class="c-dur"><col class="c-src"><col class="c-aic"></colgroup><thead><tr>
    <th class="num" data-sort="ord" data-sort-type="num">#</th>
    <th data-sort="t" data-sort-type="num">time</th>
    <th data-sort="gist" data-sort-type="str">detail</th>
    <th class="num" data-sort="res" data-sort-type="num">result</th>
    <th class="num" data-sort="dur" data-sort-type="num">dur</th>
    <th data-sort="src" data-sort-type="str">source</th>
    <th class="num" data-sort="aic" data-sort-type="num">${ul}</th>
  </tr></thead><tbody>`;
  order.forEach((ei, ord) => {
    const e = events[ei], inst = e.inst;
    const fail = inst ? toolFailReason(inst) : "";
    const gist = inst ? (fail || summarizeArgs(inst.a || "") || "—") : "(request)";
    const resLen = inst && inst.res ? inst.res.length : 0;
    const dur = inst ? (inst.d || 0) : 0;
    const exp = inst ? " expandable" : "";
    const id = ident.get(e.grp);
    const srcKey = (id ? id.short : e.grp || "") + " " + (e.dbg || "");
    // for the global path filter: any file paths in the args, falling back to the gist
    // text so path-bearing args of non-file tools (grep patterns, commands) still match.
    const pathKey = (inst ? toolFilePaths(inst.a).join(" ") : "") || gist;
    h += `<tr class="srow${exp}${fail ? " srow-failed" : ""}" data-ord="${ord}" data-t="${e.t || 0}" data-path="${escapeHtml(pathKey.toLowerCase())}" data-gist="${escapeHtml(gist.toLowerCase())}" data-res="${resLen}" data-dur="${dur}" data-src="${escapeHtml(srcKey.toLowerCase())}" data-aic="${e.aic || 0}">
      <td class="num">${ord + 1}</td>
      <td>${hms(e.t || 0)}</td>
      <td>${inst ? `<span class="caret">▸</span>` : ""}${fail ? `<span class="fail-icon" title="tool call failed">⚠</span> ` : ""}<span class="fpath">${escapeHtml(gist)}</span></td>
      <td class="num">${resLen ? qtyText(resLen) + "c" : "<span style='color:#444'>—</span>"}</td>
      <td class="num">${dur ? dur + "ms" : ""}</td>
      <td class="dbg">${agentBadgeHtml(id, e.grp)}${e.dbg ? ` <span class="dbgn">${escapeHtml(e.dbg)}</span>` : ""}</td>
      <td class="num aic">${e.aic ? fmtAic(e.aic) : "<span style='color:#444'>—</span>"}</td>
    </tr>`;
    if (inst) h += `<tr class="srow-detail collapsed"><td colspan="7"><div class="tools-inner">${toolBlockHtml(inst)}</div></td></tr>`;
  });
  h += `</tbody></table>`;
  return h;
}

// The overview rollup table (every tool, one row each, drill into callers → params).
export function buildOverviewPanel(list, ul) {
  let h = `<table class="tagg"><thead><tr>
    <th>tool</th><th class="num">calls</th><th class="num">uses</th><th class="num">failed</th>
    <th class="num">new input</th><th class="num">uncached</th><th class="num">output</th><th class="num">${ul}</th>
  </tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="8" class="muted" style="padding:12px">no calls</td></tr>`;
  list.forEach((b, bi) => {
    const failBadge = b.fails ? `<span class="toolfail-badge" title="${b.fails} of ${b.uses} call${b.uses > 1 ? "s" : ""} failed">⚠ ${b.fails}</span>` : "";
    const failCell = b.fails
      ? `<span class="failnum" title="${Math.round(100 * b.fails / b.uses)}% of ${b.uses} failed">${b.fails}</span>`
      : `<span style="color:#444">0</span>`;
    h += `<tr class="tagg-tool expandable${b.fails ? " has-fails" : ""}" data-k="t${bi}">
      <td><span class="caret">▸</span><span class="tnm">${escapeHtml(b.name)}</span>${failBadge}</td>
      <td class="num">${b.nCallers}</td>
      <td class="num">${b.uses}</td>
      <td class="num">${failCell}</td>
      <td class="num">${fmt(b.sumNew)}</td>
      <td class="num uncached">${fmt(b.sumUncached)}</td>
      <td class="num">${fmt(b.sumOut)}</td>
      <td class="num aic">${b.sumAic ? fmtAic(b.sumAic) : "<span style='color:#444'>—</span>"}</td>
    </tr>`;
    h += `<tr class="tagg-sub collapsed"><td colspan="8"><div class="tagg-sub-inner"><table class="tagg-callers"><thead><tr>
      <th>t</th><th>source</th><th class="num">new input</th><th class="num">uncached</th><th class="num">output</th><th class="num">${ul}</th><th class="num">uses</th>
    </tr></thead><tbody>`;
    b.callers.forEach((c, ci) => {
      const hasParams = c.instances.length > 0;
      const dbgClass = c.compact ? "dbg compact" : "dbg";
      const toolFailMark = c.fails ? ` <span style="color:#ff9a3c" title="${c.fails} failed tool call${c.fails > 1 ? "s" : ""}">⚠${c.fails > 1 ? c.fails : ""}</span>` : "";
      h += `<tr class="tagg-caller${hasParams ? " expandable" : ""}" data-k="t${bi}-c${ci}">
        <td>${hasParams ? `<span class="caret">▸</span>` : ""}${hms(c.t)}</td>
        <td class="${dbgClass}">${escapeHtml(c.dbg || "")}${c.err ? ` <span style="color:#f85149" title="${escapeHtml(c.errMsg || "request failed")}">✕</span>` : ""}${toolFailMark} <span class="grp">${escapeHtml(c.grp)}</span></td>
        <td class="num">${fmt(c.newInput)}</td>
        <td class="num uncached">${fmt(c.uncached)}</td>
        <td class="num">${fmt(c.out)}</td>
        <td class="num aic">${c.aic ? fmtAic(c.aic) : "<span style='color:#444'>—</span>"}</td>
        <td class="num">${c.instances.length}</td>
      </tr>`;
      if (hasParams) {
        h += `<tr class="tagg-params collapsed"><td colspan="7"><div class="tools-inner">`;
        c.instances.forEach(t => { h += toolBlockHtml(t); });
        h += `</div></td></tr>`;
      }
    });
    h += `</tbody></table></div></td></tr>`;
  });
  h += `</tbody></table>`;
  return h;
}

export function renderToolAgg(payload) {
  const { list, totalNew, totalUncached, totalOut, totalAic, totalFails } = computeToolAgg(payload);
  const ul = costColumnLabel();
  const totalUses = list.reduce((s, b) => s + b.uses, 0);

  let h = `<div class="tagg-note"><b>new input</b> = each request's input delta vs. the previous request in the same agent (a shrunk context, e.g. just after a compaction, counts as 0). <b>uncached</b> = input − cached, i.e. the raw prompt size billed each request. Tokens are attributed to every tool a request invoked, so requests calling multiple tools are counted under each — column totals can exceed the session totals below.</div>`;
  h += `<div class="tagg-totals"><span>session new input <b>${qty(totalNew)}</b></span><span>uncached <b style="color:#f85149">${qty(totalUncached)}</b></span><span>output <b>${qty(totalOut)}</b></span><span>${ul} <b style="color:#56d364">${fmtAic(totalAic)}</b></span><span>failed <b style="color:${totalFails ? "#ff9a3c" : "#444"}">${totalFails}</b>${totalUses ? ` / ${fmt(totalUses)} (${Math.round(100 * totalFails / totalUses)}%)` : ""}</span></div>`;

  // Segmented tabs: overview + one per tool, drilling into a dedicated per-tool view.
  let tabs = `<div class="tagg-tabs"><button type="button" class="tagg-tab active" data-tab="overview" data-name="overview">overview</button>`;
  list.forEach((b, bi) => { tabs += `<button type="button" class="tagg-tab${b.fails ? " has-fails" : ""}" data-tab="t${bi}" data-name="${escapeHtml(b.name)}">${escapeHtml(b.name)} <span class="tcount">${b.uses}</span>${b.fails ? `<span class="tcount tcount-fail" title="${b.fails} failed">⚠${b.fails}</span>` : ""}</button>`; });
  tabs += `</div>`;

  let panels = `<div class="tagg-panel" data-tab="overview">${buildOverviewPanel(list, ul)}</div>`;
  list.forEach((b, bi) => {
    const inner = b.name === "read_file" ? buildFilePanel(b, ul) : buildGenericPanel(b, ul);
    panels += `<div class="tagg-panel" data-tab="t${bi}" hidden>${inner}</div>`;
  });

  return h + tabs + panels;
}

