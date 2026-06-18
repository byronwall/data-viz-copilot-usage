import { PALETTE, escapeHtml, fmt, hms, qtyText } from "./format.mjs";
import { toolBlockHtml, toolFailReason } from "./detail.mjs";
import { agentBadgeHtml, computeToolAgg, fileRange, guessRoot, lineHeatStrip, parseRange, pickPathKey, relTo, stableAgentIdent, toolFilePath, underRoot } from "./tool-agg.mjs";

// ---------- "By file" aggregate view ----------
// Groups every file-touching tool invocation (read_file, apply_patch, create_file,
// get_errors, …) by the file it acted on, so a session reads as "what got touched and
// how often" instead of turn-by-turn. A heatmap mode renders one line-coverage strip
// per ACTION per file, so you can see where in the file each kind of action landed.

// All file paths a tool invocation acted on. Extends toolFilePath to multi-file args
// (get_errors filePaths, runTests files) and apply_patch's inline patch headers.
export function toolFilePaths(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] !== "{") return [];
  let o;
  try { o = JSON.parse(s); } catch (_) { return []; }
  const single = pickPathKey(o);
  if (single) return [single];
  for (const k of ["filePaths", "files"]) {
    if (Array.isArray(o[k])) return o[k].filter(p => typeof p === "string");
  }
  // apply_patch: paths live in the patch text ("*** Update File: /path", Add/Delete too)
  if (typeof o.input === "string" && o.input.includes("*** Begin Patch")) {
    const out = [];
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(o.input)) !== null) out.push(m[1].trim());
    return out;
  }
  return [];
}

// Flatten the session into one event per (tool invocation × file it touched), tagged
// with the same group labels computeToolAgg uses so agent identity stays consistent.
export function collectFileEvents(payload) {
  const groups = [{ grp: "foreground", calls: payload.main || [] }];
  (payload.kids || []).forEach((k, ki) => {
    const grp = k.is_search_child
      ? `🔍 search-subagent ${k.child_sid ? k.child_sid.slice(0, 8) : ""}`
      : `sub-agent: ${k.label || ("K" + ki)}`;
    groups.push({ grp, calls: k.calls || [] });
  });
  const events = [];
  let skipped = 0;
  groups.forEach(g => g.calls.forEach(c => (c.tools || []).forEach(t => {
    const paths = toolFilePaths(t.a);
    if (!paths.length) { skipped++; return; }
    const fail = toolFailReason(t);
    paths.forEach(path => events.push({
      path, tool: t.n || "?", t: t.t != null ? t.t : c.t, grp: g.grp, dbg: c.dbg,
      span: parseRange(t.a), range: fileRange(t.a),
      resLen: t.res ? t.res.length : 0, dur: t.d || 0, inst: t, fail,
    }));
  })));
  return { events, skipped };
}

// Stable color per action (tool name), assigned by frequency so the dominant actions
// get the first palette slots in every part of the view.
export function toolColorMap(events) {
  const counts = new Map();
  events.forEach(e => counts.set(e.tool, (counts.get(e.tool) || 0) + 1));
  const names = [...counts.keys()].sort((a, z) => counts.get(z) - counts.get(a));
  const map = new Map();
  names.forEach((n, i) => map.set(n, PALETTE[i % PALETTE.length]));
  return map;
}

export function toolChipHtml(name, count, col) {
  return `<span class="ftool-chip" style="--tc:${col}">${escapeHtml(name)}${count != null ? ` <b>${count}</b>` : ""}</span>`;
}

// File summary table: one row per file with per-action counts and a small-multiple
// strip showing WHICH line regions the actions covered (heat = same lines re-touched);
// a row expands to the full time-ordered list of every action on that file (args + result).
export function buildFileAggTable(files, toolCol, ident) {
  let h = `<div class="tagg-file-sub muted">click a row for every action on that file · click a ↕ header to sort · regions strip: line coverage, cool→hot as the same lines are re-touched (hover a band for its range)</div>`;
  h += `<table class="tagg-files fagg-tbl"><colgroup><col class="c-num"><col class="c-file"><col class="c-reads"><col class="c-chips"><col class="c-regions"><col class="c-res"><col class="c-dur"><col class="c-src"></colgroup><thead><tr>
    <th class="num" data-sort="ord" data-sort-type="num">#</th>
    <th data-sort="file" data-sort-type="str">file</th>
    <th class="num" data-sort="n" data-sort-type="num">actions</th>
    <th data-sort="tools" data-sort-type="str">by action</th>
    <th data-sort="lines" data-sort-type="num">regions</th>
    <th class="num" data-sort="res" data-sort-type="num">result</th>
    <th class="num" data-sort="dur" data-sort-type="num">dur</th>
    <th data-sort="src" data-sort-type="str">agents</th>
  </tr></thead><tbody>`;
  files.forEach((f, fi) => {
    const chips = [...f.byTool.entries()].sort((a, z) => z[1].length - a[1].length)
      .map(([n, evs]) => toolChipHtml(n, evs.length, toolCol.get(n))).join(" ");
    const agents = [...f.agents].map(g => {
      const id = ident.get(g);
      return `<i class="heat-swatch" style="background:${id ? id.color : "#444"}" title="${escapeHtml(g)}">${id ? id.icon : "?"}</i>`;
    }).join("");
    const toolKey = [...f.byTool.keys()].sort().join(" ");
    // mini coverage strip across the file's known line range; actions without ranges
    // (patches, whole-file reads) don't contribute bands.
    const spans = f.events.map(e => e.span).filter(Boolean);
    const maxLine = spans.length ? Math.max(...spans.map(s => s.end)) : 0;
    const regions = maxLine
      ? `<span class="mini-heat" title="${spans.length} ranged action${spans.length > 1 ? "s" : ""} over ~${fmt(maxLine)} lines">${lineHeatStrip(spans, maxLine).svg}<span class="mini-heat-max">${fmt(maxLine)}</span></span>`
      : `<span style="color:#444">—</span>`;
    const fileFailBadge = f.fails ? ` <span class="toolfail-badge" title="${f.fails} failed action${f.fails > 1 ? "s" : ""} on this file">⚠ ${f.fails}</span>` : "";
    h += `<tr class="srow expandable${f.fails ? " srow-failed" : ""}" data-ord="${fi}" data-file="${escapeHtml(f.rel.toLowerCase())}" data-path="${escapeHtml((f.path || f.rel).toLowerCase())}" data-n="${f.events.length}" data-tools="${escapeHtml(toolKey.toLowerCase())}" data-lines="${maxLine}" data-res="${f.res}" data-dur="${f.dur}" data-src="${escapeHtml([...f.agents].join(" ").toLowerCase())}">
      <td class="num">${fi + 1}</td>
      <td><span class="caret">▸</span><span class="fpath${f.ext ? " ext" : ""}" title="${escapeHtml(f.path)}">${f.ext ? "↗ " : ""}${escapeHtml(f.rel)}</span>${fileFailBadge}</td>
      <td class="num">${f.events.length}</td>
      <td class="fchips">${chips}</td>
      <td class="fregions">${regions}</td>
      <td class="num">${f.res ? qtyText(f.res) + "c" : "<span style='color:#444'>—</span>"}</td>
      <td class="num">${f.dur ? f.dur + "ms" : ""}</td>
      <td class="fagents">${agents}</td>
    </tr>`;
    let inner = "";
    f.events.forEach(e => {
      const id = ident.get(e.grp);
      inner += `<div class="fagg-evt${e.fail ? " evt-failed" : ""}"><span class="fagg-t">${hms(e.t)}</span>${e.fail ? `<span class="fail-icon" title="tool call failed">⚠</span>` : ""}${toolChipHtml(e.tool, null, toolCol.get(e.tool))}${e.range ? `<span class="frange">${escapeHtml(e.range)}</span>` : ""}${agentBadgeHtml(id, e.grp)}</div>${toolBlockHtml(e.inst)}`;
    });
    h += `<tr class="srow-detail collapsed"><td colspan="8"><div class="tools-inner">${inner}</div></td></tr>`;
  });
  h += `</tbody></table>`;
  return h;
}

export function renderFileAgg(payload) {
  const { events, skipped } = collectFileEvents(payload);
  if (!events.length) return `<div class="tagg-file-sub muted" style="padding:16px 12px">No file-touching tool calls in this session.</div>`;
  const root = guessRoot(events.map(e => e.path));
  events.forEach(e => { e.rel = relTo(root, e.path); e.ext = !underRoot(root, e.path); });
  const ident = stableAgentIdent(events);
  const toolCol = toolColorMap(events);

  const fileMap = new Map();
  events.forEach(e => {
    let f = fileMap.get(e.rel);
    if (!f) { f = { rel: e.rel, path: e.path, ext: e.ext, events: [], byTool: new Map(), agents: new Set(), res: 0, dur: 0, fails: 0 }; fileMap.set(e.rel, f); }
    f.events.push(e); f.agents.add(e.grp); f.res += e.resLen; f.dur += e.dur; if (e.fail) f.fails++;
    if (!f.byTool.has(e.tool)) f.byTool.set(e.tool, []);
    f.byTool.get(e.tool).push(e);
  });
  const files = [...fileMap.values()].sort((a, z) => z.events.length - a.events.length || a.rel.localeCompare(z.rel));
  files.forEach(f => f.events.sort((a, z) => a.t - z.t));

  const toolSummary = [...toolCol.entries()].map(([n, col]) =>
    toolChipHtml(n, events.filter(e => e.tool === n).length, col)).join(" ");

  let h = `<div class="tagg-file-head"><span>root <code>${root ? escapeHtml(root) : "—"}</code></span><span><b>${files.length}</b> files · <b>${events.length}</b> actions${skipped ? ` · <span class="muted">${skipped} tool calls without a file path not shown</span>` : ""}</span></div>`;
  h += `<div class="tagg-file-head fagg-tools">${toolSummary}</div>`;
  h += buildFileAggTable(files, toolCol, ident);
  return h;
}

