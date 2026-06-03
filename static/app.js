// Copilot usage viewer frontend.
// Charts are SVG, rendered client-side from session payloads so filtering is responsive.

const PALETTE = ["#a371f7", "#3fb950", "#ff7b72", "#f0883e", "#79c0ff", "#ffa657", "#d2a8ff", "#56d364"];

function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtAic(n) {
  n = Number(n || 0);
  if (n === 0) return "0";
  if (n < 1000) return n.toFixed(1);  // one decimal, like VS Code's credit badge
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
}
function pad(x) { return String(x).padStart(2, "0"); }
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
// Render a tool arg/result blob: JSON objects become a dense 2-column key/value
// table; everything else renders as a verbatim text chunk.
function renderValue(str) {
  str = String(str ?? "");
  const trimmed = str.trim();
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const rows = Object.entries(obj).map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          return `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(val)}</td></tr>`;
        }).join("");
        if (rows) return `<table class="kv">${rows}</table>`;
      }
    } catch (_) { /* fall through to text */ }
  }
  return `<div class="txt">${escapeHtml(str)}</div>`;
}
// One-line gist of a tool's args for the collapsed summary row — pick the single
// most telling field (file path, command, query, …) or fall back to the raw text.
function summarizeArgs(str) {
  const t = String(str ?? "").trim();
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const keys = ["filePath", "path", "command", "query", "pattern", "search",
                      "filePattern", "includePattern", "description", "agentName",
                      "explanation", "input", "url"];
        const pick = keys.find(k => obj[k] != null && obj[k] !== "")
          || Object.keys(obj).find(k => obj[k] != null && obj[k] !== "");
        if (pick) {
          const v = obj[pick];
          return oneLine(typeof v === "string" ? v : JSON.stringify(v));
        }
        return "";
      }
    } catch (_) { /* fall through */ }
  }
  return oneLine(t);
}
function oneLine(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 110 ? s.slice(0, 109) + "…" : s;
}
function niceCeil(n) {
  if (n <= 0) return 1000;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  for (const f of [1, 1.5, 2, 2.5, 5, 10]) if (mag * f >= n) return mag * f;
  return n;
}
function dotFill(c) {
  const cp = c.input > 0 ? c.cached / c.input : 0;
  return cp > 0.7 ? "#58a6ff" : (cp > 0.3 ? "#d29922" : "#f85149");
}

function localMaxT(payload) {
  let mx = 1000;
  for (const c of payload.main || []) if (c.t > mx) mx = c.t;
  for (const k of payload.kids || []) for (const c of k.calls) if (c.t > mx) mx = c.t;
  return Math.max(60000, Math.ceil(mx / 30000) * 30000);
}

function renderChart(payload, opts) {
  const { w = 360, h = 380, maxTok, big = false, interactive = false } = opts || {};
  const localMax = localMaxT(payload);
  // Layout: top header (mt) → main chart (ih_main) → time labels (timeAxisH) →
  //         sub chart (ih_sub) → footer (mb)
  const ml = big ? 70 : 56, mr = 16;
  const mt = big ? 50 : 44;
  const mb = big ? 44 : 36;
  const subH = big ? 100 : 60;       // height of the per-turn input sub-chart
  const timeAxisH = big ? 22 : 18;   // space for the shared x-axis labels between the two bands
  const iw = w - ml - mr;
  const ih = h - mt - mb - subH - timeAxisH;  // main chart height
  // (ih is the "main" chart band. sub-chart sits below the time labels.)
  const X = t => ml + (t / localMax) * iw;
  const Y = tok => mt + ih - (Math.min(tok, maxTok) / maxTok) * ih;

  let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace,monospace" font-size="${big ? 11 : 9}" data-sid="${payload.sid}">`;
  svg += `<rect width="${w}" height="${h}" fill="#0e1116"/>`;
  svg += `<rect x="${ml}" y="${mt}" width="${iw}" height="${ih}" fill="#161b22" stroke="#30363d"/>`;
  for (const frac of [0, 0.25, 0.5, 0.75, 1.0]) {
    const y = mt + ih - frac * ih;
    const tok = maxTok * frac;
    svg += `<line x1="${ml}" y1="${y}" x2="${ml + iw}" y2="${y}" stroke="#21262d"/>`;
    const lbl = tok >= 1e6 ? `${(tok / 1e6).toFixed(1)}M` : (tok >= 1000 ? `${Math.round(tok / 1000)}k` : "0");
    svg += `<text x="${ml - 4}" y="${y + 3}" fill="#8b949e" text-anchor="end">${lbl}</text>`;
    const x = ml + frac * iw;
    svg += `<line x1="${x}" y1="${mt}" x2="${x}" y2="${mt + ih}" stroke="#21262d"/>`;
    svg += `<text x="${x}" y="${mt + ih + 12}" fill="#8b949e" text-anchor="middle">${hms(localMax * frac)}</text>`;
  }
  svg += `<text x="${ml + iw / 2}" y="${mt + ih + 24}" fill="#7d8590" text-anchor="middle" font-size="${big ? 10 : 9}">total ${hms(localMax)}</text>`;
  if (big) {
    svg += `<text transform="translate(16,${mt + ih / 2}) rotate(-90)" fill="#c9d1d9" text-anchor="middle" font-size="11">cumulative input tokens</text>`;
  }

  // foreground line (excluding compactions and failed 0-token requests)
  const mainNonCompact = (payload.main || []).filter(c => !c.compact && !c.err);
  if (mainNonCompact.length >= 2) {
    const path = "M " + mainNonCompact.map(c => `${X(c.t).toFixed(1)},${Y(c.cum).toFixed(1)}`).join(" L ");
    svg += `<path d="${path}" fill="none" stroke="#58a6ff" stroke-width="${big ? 2 : 1.7}" opacity="0.95"/>`;
  }
  for (const c of mainNonCompact) {
    const r = Math.max(1.2, Math.min(big ? 8 : 5, Math.sqrt(c.input / 3000) + 0.6));
    const attr = interactive ? ` class="dot" data-idx="P-${c.idx}"` : "";
    svg += `<circle cx="${X(c.t).toFixed(1)}" cy="${Y(c.cum).toFixed(1)}" r="${r.toFixed(1)}" fill="${dotFill(c)}" opacity="0.92"${attr}/>`;
  }

  // children
  (payload.kids || []).forEach((k, i) => {
    const col = k.is_search_child ? "#79c0ff" : PALETTE[i % PALETTE.length];
    const dash = k.is_search_child ? "5,2" : (big ? "4,3" : "2,2");
    const pts = [[k.start_t, k.start_tok]].concat(k.calls.map(c => [c.t, c.cum_offset]));
    const path = "M " + pts.map(([t, tok]) => `${X(t).toFixed(1)},${Y(tok).toFixed(1)}`).join(" L ");
    svg += `<path d="${path}" fill="none" stroke="${col}" stroke-width="${big ? 1.8 : 1.3}" stroke-dasharray="${dash}" opacity="0.9"/>`;
    for (const c of k.calls) {
      const r = big ? Math.max(2.5, Math.min(7, Math.sqrt(c.input / 3000) + 0.6)) : 2.4;
      const attr = interactive ? ` class="dot" data-idx="K${i}-${c.idx}"` : "";
      svg += `<circle cx="${X(c.t).toFixed(1)}" cy="${Y(c.cum_offset).toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" opacity="0.95"${attr}/>`;
    }
    // mark the spawn point with a small ring so the user can see where the search kicked off
    if (k.is_search_child) {
      svg += `<circle cx="${X(k.start_t).toFixed(1)}" cy="${Y(k.start_tok).toFixed(1)}" r="${big ? 4 : 3}" fill="none" stroke="${col}" stroke-width="1" opacity="0.7"/>`;
    }
  });

  // compaction diamonds
  for (const c of (payload.main || [])) {
    if (!c.compact) continue;
    const x = X(c.t), y = Y(c.cum), s = big ? 9 : 6;
    const attr = interactive ? ` class="dot" data-idx="P-${c.idx}"` : "";
    svg += `<polygon points="${x - s},${y} ${x},${y - s} ${x + s},${y} ${x},${y + s}" fill="#ff9a3c" stroke="#ffe7c2" stroke-width="0.8"${attr}/>`;
  }
  (payload.kids || []).forEach((k, i) => {
    for (const c of k.calls) {
      if (!c.compact) continue;
      const x = X(c.t), y = Y(c.cum_offset), s = big ? 8 : 5;
      const attr = interactive ? ` class="dot" data-idx="K${i}-${c.idx}"` : "";
      svg += `<polygon points="${x - s},${y} ${x},${y - s} ${x + s},${y} ${x},${y + s}" fill="#ff9a3c" stroke="#ffe7c2" stroke-width="0.6"${attr}/>`;
    }
  });

  // header — two lines
  const cp = payload.total_input > 0 ? Math.round(100 * payload.total_cached / payload.total_input) : 0;
  // last_event_ts (epoch ms) is the real end of the chat; fall back to file mtime only if absent.
  // mtime can drift to "now" when Copilot rewrites the log on reopen, so it must not drive the date.
  const dateMs = payload.last_event_ts || payload.mtime * 1000;
  const date = new Date(dateMs).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const nReq = (payload.main || []).length;
  const nKids = (payload.kids || []).length;
  const nCompact = payload.n_compactions || (payload.main || []).filter(c => c.compact).length + (payload.kids || []).reduce((s, k) => s + k.calls.filter(c => c.compact).length, 0);
  const nSearchKids = (payload.kids || []).filter(k => k.is_search_child).length;
  const nRealKids = nKids - nSearchKids;

  const fs1 = big ? 12 : 10.5;
  const fs2 = big ? 11 : 9.5;
  // Row 1: date + total input + cache% + AIC  (the "what did this cost" line)
  let row1 = `<text x="6" y="${big ? 16 : 14}" fill="#c9d1d9" font-size="${fs1}" font-weight="600">${escapeHtml(date)} · <tspan fill="#c9d1d9">${fmt(payload.total_input)}</tspan> in · <tspan fill="${cp >= 70 ? "#58a6ff" : cp >= 30 ? "#d29922" : "#f85149"}">${cp}%</tspan> cache`;
  if (payload.total_aic > 0) row1 += ` · <tspan fill="#56d364">${fmtAic(payload.total_aic)} AIC</tspan>`;
  row1 += `</text>`;
  // Row 2: turn structure (reqs, subs, compactions, linkage chips)
  let row2parts = [`${nReq} req`];
  if (nRealKids > 0) row2parts.push(`<tspan fill="#a371f7">${nRealKids} sub</tspan>`);
  if (nSearchKids > 0) row2parts.push(`<tspan fill="#79c0ff">${nSearchKids}🔍</tspan>`);
  if (nCompact > 0) row2parts.push(`<tspan fill="#ff9a3c">${nCompact}◆</tspan>`);
  if (payload.parent_sid) row2parts.push(`<tspan fill="#a371f7">↑child</tspan>`);
  const row2 = `<text x="6" y="${big ? 33 : 28}" fill="#8b949e" font-size="${fs2}">${row2parts.join(" · ")}</text>`;
  svg += row1 + row2;

  // -------- Sub-chart: per-turn input tokens for the foreground agent --------
  // Same x-axis (time) as the main chart; new y-axis scaled to this session's max per-turn input.
  const subTop = mt + ih + timeAxisH;
  const subBot = subTop + subH;
  // Only the primary foreground agent — main.jsonl interleaves backgroundTodoAgent,
  // compaction, etc., whose tiny turns would render as misleading drops to ~0.
  // Also drop failed requests (status:error) — they report 0 input tokens.
  const mainTurns = (payload.main || []).filter(c => c.dbg === "panel/editAgent" && !c.err);
  let maxPerTurn = 0;
  for (const c of mainTurns) if (c.input > maxPerTurn) maxPerTurn = c.input;
  // sub-agents each get their own per-turn line, so their turns count toward the y-scale too
  for (const k of (payload.kids || [])) for (const c of k.calls) if (!c.err && c.input > maxPerTurn) maxPerTurn = c.input;
  const niceMaxPerTurn = niceCeil(maxPerTurn || 1000);
  const subY = v => subBot - (Math.min(v, niceMaxPerTurn) / niceMaxPerTurn) * subH;

  // sub-chart frame
  svg += `<rect x="${ml}" y="${subTop}" width="${iw}" height="${subH}" fill="#161b22" stroke="#30363d"/>`;
  // y grid lines + labels (only 3 to keep it readable in compact mode)
  for (const frac of [0, 0.5, 1.0]) {
    const y = subBot - frac * subH;
    svg += `<line x1="${ml}" y1="${y}" x2="${ml + iw}" y2="${y}" stroke="#21262d"/>`;
    const tok = niceMaxPerTurn * frac;
    const lbl = tok >= 1000 ? `${Math.round(tok / 1000)}k` : (tok > 0 ? String(Math.round(tok)) : "0");
    svg += `<text x="${ml - 4}" y="${y + 3}" fill="#8b949e" text-anchor="end" font-size="${big ? 10 : 8.5}">${lbl}</text>`;
  }
  // sub-chart axis label
  if (big) {
    svg += `<text transform="translate(16,${subTop + subH / 2}) rotate(-90)" fill="#7d8590" text-anchor="middle" font-size="10">per-turn input</text>`;
  } else {
    svg += `<text x="${ml + 4}" y="${subTop + 9}" fill="#7d8590" font-size="8.5">per-turn input</text>`;
  }

  // line through foreground per-turn inputs (no fill — keeps the band readable
  // once sub-agent lines are layered on top).
  if (mainTurns.length >= 1) {
    const pts = mainTurns.map(c => [X(c.t), subY(c.input)]);
    if (pts.length >= 2) {
      const linePath = "M " + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
      svg += `<path d="${linePath}" fill="none" stroke="#58a6ff" stroke-width="${big ? 1.4 : 1.2}" opacity="0.85"/>`;
    }
    // small per-turn dots colored by cache hit (re-using main palette)
    for (const c of mainTurns) {
      const fill = dotFill(c);
      const r = big ? 2 : 1.4;
      svg += `<circle cx="${X(c.t).toFixed(1)}" cy="${subY(c.input).toFixed(1)}" r="${r}" fill="${fill}" opacity="0.95"/>`;
    }
  }

  // one dedicated per-turn line per sub-agent, colored to match the main chart
  (payload.kids || []).forEach((k, i) => {
    const col = k.is_search_child ? "#79c0ff" : PALETTE[i % PALETTE.length];
    const dash = k.is_search_child ? "5,2" : (big ? "4,3" : "2,2");
    const turns = k.calls.filter(c => !c.err);
    if (turns.length === 0) return;
    const pts = turns.map(c => [X(c.t), subY(c.input)]);
    if (pts.length >= 2) {
      const linePath = "M " + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
      svg += `<path d="${linePath}" fill="none" stroke="${col}" stroke-width="${big ? 1.3 : 1}" stroke-dasharray="${dash}" opacity="0.85"/>`;
    }
    for (const [x, y] of pts) {
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 1.8 : 1.2}" fill="${col}" opacity="0.9"/>`;
    }
  });

  // Footer: first user message
  const title = escapeHtml((payload.first_user || "(no user msg)").slice(0, big ? 110 : 70));
  svg += `<text x="6" y="${h - 4}" fill="#7d8590" font-size="${big ? 11 : 9}">${title}</text>`;
  svg += "</svg>";
  return svg;
}

function bar(input, cached) {
  const cp = input > 0 ? cached / input : 0;
  const cw = Math.round(cp * 100);
  return `<span class="bar"><i style="width:${cw}%"></i><i class="uncached" style="width:${100 - cw}%"></i></span>`;
}

function renderDetail(payload) {
  const all = [];
  (payload.main || []).forEach(c => all.push({ ...c, _grp: "P" }));
  (payload.kids || []).forEach((k, ki) => k.calls.forEach(c => all.push({ ...c, _grp: "K" + ki, _label: k.label })));
  const total_in = payload.total_input, total_cached = payload.total_cached, total_out = payload.total_output;
  const total_uncached = total_in - total_cached;
  const compactCalls = all.filter(c => c.compact);
  const compact_total = compactCalls.reduce((s, c) => s + c.input, 0);
  const total_aic = payload.total_aic != null ? payload.total_aic : all.reduce((s, c) => s + (c.aic || 0), 0);

  // No chips — search-children are rendered inline as sub-agent sections in the table.
  // For orphan find-sessions (those visible standalone because no parent was matched), show a
  // single inert note so the user knows it came from a wider context. Otherwise nothing here.
  let linkChip = "";
  if (payload.parent_sid && payload.parent_first_user) {
    linkChip = `<div class="chip muted-chip">spawned by: ${escapeHtml(payload.parent_first_user.slice(0, 100))}</div>`;
  }

  let html = `
  <div class="modal-header">
    <div class="modal-meta">${escapeHtml(payload.sid)} · ws ${escapeHtml(payload.workspace || "")} · ${new Date(payload.last_event_ts || payload.mtime * 1000).toLocaleString()} · model ${escapeHtml(payload.top_model)}</div>
    <div class="modal-prompt">${escapeHtml(payload.first_user || "(no user message)")}</div>
    ${linkChip}
    <div class="modal-totals">
      <span>input <b>${fmt(total_in)}</b></span>
      <span>cached <b style="color:#58a6ff">${fmt(total_cached)}</b> (${total_in ? Math.round(100 * total_cached / total_in) : 0}%)</span>
      <span>uncached <b style="color:#f85149">${fmt(total_uncached)}</b></span>
      <span>output <b>${fmt(total_out)}</b></span>
      <span>AIC <b style="color:#56d364">${fmtAic(total_aic)}</b></span>
      <span>turns <b>${all.length}</b></span>
      <span>compactions <b style="color:#ff9a3c">${compactCalls.length}</b> (${fmt(compact_total)} tok)</span>
      <span>duration <b>${hms(payload.duration_ms)}</b></span>
    </div>
  </div>
  <table class="calls">
    <thead><tr>
      <th>#</th><th>t</th><th>debugName</th>
      <th class="num">input</th><th class="num">cached</th><th>cache%</th>
      <th class="num">out</th><th class="num">AIC</th><th>tool calls</th>
    </tr></thead><tbody>`;

  // build a kid-meta lookup so we can label search-children with a jump link
  const kidMeta = {};
  (payload.kids || []).forEach((k, ki) => { kidMeta["K" + ki] = k; });

  let curGrp = null;
  all.forEach((c, _i) => {
    if (c._grp !== curGrp) {
      curGrp = c._grp;
      let label;
      if (curGrp.startsWith("K")) {
        const km = kidMeta[curGrp];
        if (km && km.is_search_child) {
          // Render inline, identical structure to a regular sub-agent section — no jump.
          label = `<span style="color:#79c0ff">🔍 search-subagent</span> · ${escapeHtml(km.child_sid ? km.child_sid.slice(0, 8) : "")}`;
        } else {
          label = `▸ sub-agent: ${escapeHtml(c._label || curGrp)}`;
        }
      } else {
        label = `▸ foreground (panel/editAgent)`;
      }
      html += `<tr class="kid-section"><td colspan="9">${label}</td></tr>`;
    }
    const cp = c.input > 0 ? c.cached / c.input : 0;
    const idx = `${c._grp}-${c.idx}`;
    const dbgClass = c.compact ? "dbg compact" : "dbg";
    const compactClass = c.compact ? "compact-row" : "";
    const tools = c.tools || [];
    const hasTools = tools.length > 0;
    const toolSummary = tools.length === 0
      ? `<span style="color:#444">—</span>`
      : tools.slice(0, 3).map(t => `<span style="color:#79c0ff">${escapeHtml(t.n)}</span>`).join(" ")
        + (tools.length > 3 ? ` <span style="color:#666">+${tools.length - 3}</span>` : "");
    html += `<tr class="call ${compactClass}${hasTools ? " expandable" : ""}" data-idx="${idx}">
      <td>${hasTools ? `<span class="caret">▸</span>` : ""}${c.idx + 1}</td>
      <td>${hms(c.t)}</td>
      <td class="${dbgClass}">${escapeHtml(c.dbg)}${c.err ? ` <span style="color:#f85149" title="${escapeHtml(c.err_msg || "request failed")}">✕ error</span>` : ""}</td>
      <td class="num">${fmt(c.input)}</td>
      <td class="num cached">${fmt(c.cached)}</td>
      <td>${c.err ? `<span style="color:#f85149">${escapeHtml((c.err_msg || "failed").slice(0, 48))}</span>` : `${bar(c.input, c.cached)} ${Math.round(cp * 100)}%`}</td>
      <td class="num">${fmt(c.output)}</td>
      <td class="num aic">${c.aic ? fmtAic(c.aic) : "<span style='color:#444'>—</span>"}</td>
      <td>${toolSummary}</td>
    </tr>`;
    if (tools.length > 0) {
      html += `<tr class="tools collapsed"><td colspan="9"><div class="tools-inner">`;
      tools.forEach(t => {
        const dur = t.d > 0 ? `<span class="dur">${t.d}ms</span>` : "";
        const summary = summarizeArgs(t.a || "");
        let detail = renderValue(t.a || "");
        if (t.res) detail += `<div class="res"><span class="reslbl">result</span><div class="res-body clamped">${renderValue(t.res)}</div><button class="res-toggle" type="button">show more</button></div>`;
        html += `<div class="tool"><div class="tool-head"><span class="caret">▸</span><span class="nm">${escapeHtml(t.n)}</span>${dur}<span class="summary">${escapeHtml(summary)}</span></div><div class="tool-detail collapsed">${detail}</div></div>`;
      });
      html += `</div></td></tr>`;
    }
  });
  html += "</tbody></table>";
  return html;
}

// ---------- Click-to-select chart ↔ table ----------
function wireSelect(svgEl, rightEl) {
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
function wireExpand(rightEl) {
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
}

// ---------- Modal ----------
let MODAL_SID = null;

async function openModal(sid, maxTok) {
  const modal = document.getElementById("modal");
  const chartHolder = document.getElementById("modalChart");
  const right = document.getElementById("modalRight");
  chartHolder.innerHTML = `<div class="muted" style="padding:20px">loading…</div>`;
  right.innerHTML = "";
  modal.classList.add("open");
  MODAL_SID = sid;
  syncUrl(true); // push so Back closes the modal

  let payload;
  try {
    const resp = await fetch(`/api/session/${encodeURIComponent(sid)}`);
    if (!resp.ok) throw new Error("404");
    payload = await resp.json();
  } catch (e) {
    chartHolder.innerHTML = `<div class="muted">failed to load session</div>`;
    return;
  }

  // For the expanded modal chart, scale Y to THIS session's own peak so its dynamics fill
  // the frame. The shared global maxTok continues to govern the small multiples.
  let sessionPeak = 0;
  for (const c of payload.main || []) if (c.cum > sessionPeak) sessionPeak = c.cum;
  for (const k of payload.kids || []) for (const c of k.calls) if (c.cum_offset > sessionPeak) sessionPeak = c.cum_offset;
  const modalMaxTok = niceCeil(sessionPeak || 1000);
  chartHolder.innerHTML = renderChart(payload, { w: 720, h: 540, maxTok: modalMaxTok, big: true, interactive: true });
  right.innerHTML = renderDetail(payload);
  document.getElementById("modalLegend").innerHTML = `
    <span><span class="dot" style="background:#58a6ff"></span>foreground</span>
    <span><span class="dot" style="background:#a371f7"></span>sub-agent (dashed)</span>
    <span><span class="dia"></span>compaction</span>
    <span><span class="dot" style="background:#d29922"></span>med cache</span>
    <span><span class="dot" style="background:#f85149"></span>cold cache</span>
    <span class="muted">click a dot or row to select</span>`;
  wireSelect(chartHolder.querySelector("svg"), right);
  wireExpand(right);
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
  if (MODAL_SID) { MODAL_SID = null; syncUrl(true); }
}
document.getElementById("closeBtn").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); closeCal(); } });

// ---------- Date range controls ----------
const startEl = document.getElementById("start_date");
const endEl = document.getElementById("end_date");
const rangeInfoEl = document.getElementById("rangeInfo");

// True while the window means "the last N hours up to now" (initial load and the
// quick buttons). Refresh then re-anchors the window to now so sessions written
// since the last load are included. Manually edited dates, calendar day picks,
// and ◀/▶ stepping express a fixed historical window, which unpins.
let RANGE_PINNED = true;

// datetime-local needs "YYYY-MM-DDTHH:mm" in LOCAL time (no TZ suffix)
function tsToLocalInput(ts) {
  const d = new Date(ts * 1000);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
function localInputToTs(v) {
  if (!v) return null;
  return Math.floor(new Date(v).getTime() / 1000);
}
function getRangeTs() {
  return [localInputToTs(startEl.value), localInputToTs(endEl.value)];
}
function setRangeTs(startTs, endTs) {
  startEl.value = tsToLocalInput(startTs);
  endEl.value = tsToLocalInput(endTs);
  updateRangeInfo();
  updateQuickActive();
}
function updateRangeInfo() {
  const [s, e] = getRangeTs();
  if (!s || !e) { rangeInfoEl.textContent = ""; return; }
  const hrs = (e - s) / 3600;
  let label;
  if (hrs < 1) label = `${Math.round((e - s) / 60)}m`;
  else if (hrs < 48) label = `${hrs.toFixed(hrs < 6 ? 1 : 0)}h`;
  else label = `${(hrs / 24).toFixed(1)}d`;
  rangeInfoEl.textContent = `(${label} window)`;
}
function updateQuickActive() {
  const [s, e] = getRangeTs();
  if (!s || !e) return;
  const now = Math.floor(Date.now() / 1000);
  // a quick button matches if end ≈ now (within 90s) and (end-start)*3600 = its hours
  const nowish = Math.abs(e - now) < 90;
  const hours = (e - s) / 3600;
  document.querySelectorAll("button.quick").forEach(b => {
    const h = Number(b.dataset.hours);
    b.classList.toggle("active", nowish && Math.abs(hours - h) < 0.05);
  });
}
function shiftRange(direction) {
  const [s, e] = getRangeTs();
  if (!s || !e) return;
  const span = e - s;
  setRangeTs(s + direction * span, e + direction * span);
}

document.querySelectorAll("button.quick").forEach(b => {
  b.addEventListener("click", () => {
    const h = Number(b.dataset.hours);
    const now = Math.floor(Date.now() / 1000);
    RANGE_PINNED = true;
    setRangeTs(now - h * 3600, now);
    loadSessions();
  });
});
document.getElementById("prevBtn").addEventListener("click", () => { RANGE_PINNED = false; shiftRange(-1); loadSessions(); });
document.getElementById("nextBtn").addEventListener("click", () => { RANGE_PINNED = false; shiftRange(+1); loadSessions(); });
startEl.addEventListener("change", () => { RANGE_PINNED = false; updateRangeInfo(); updateQuickActive(); loadSessions(); });
endEl.addEventListener("change", () => { RANGE_PINNED = false; updateRangeInfo(); updateQuickActive(); loadSessions(); });

// ---------- URL state ----------
// Every control + open overlays serialize into query params so a refresh (or a
// shared link) restores the exact view. Pinned "last N hours" windows persist as
// hours=N (re-anchored to now on load); explicit windows persist as start/end
// unix timestamps. Params at their defaults are omitted to keep URLs clean.
const URL_DEFAULTS = { hours: 24, sort: "total_input", limit: "50", min_tokens: "0" };
let SUPPRESS_URL = false; // true while restoring state FROM the URL

function syncUrl(push = false) {
  if (SUPPRESS_URL) return;
  const p = new URLSearchParams();
  const [s, e] = getRangeTs();
  if (RANGE_PINNED && s && e) {
    const hours = (e - s) / 3600;
    if (Math.abs(hours - URL_DEFAULTS.hours) > 0.01) p.set("hours", String(+hours.toFixed(2)));
  } else if (s && e) {
    p.set("start", String(s));
    p.set("end", String(e));
  }
  const sort = document.getElementById("sort").value;
  if (sort !== URL_DEFAULTS.sort) p.set("sort", sort);
  const limit = document.getElementById("limit").value;
  if (limit !== URL_DEFAULTS.limit) p.set("limit", limit);
  const minTok = document.getElementById("min_tokens").value;
  if (minTok !== URL_DEFAULTS.min_tokens) p.set("min_tokens", minTok);
  if (CAL_SELECTED) p.set("day", CAL_SELECTED);
  if (!calPop.hidden) { p.set("cal", "1"); p.set("cal_year", String(CAL_YEAR)); }
  if (MODAL_SID) p.set("session", MODAL_SID);
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

function applyUrlState() {
  const p = new URLSearchParams(location.search);
  SUPPRESS_URL = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = Number(p.get("start")), end = Number(p.get("end"));
    if (start && end && end > start) {
      RANGE_PINNED = false;
      setRangeTs(start, end);
    } else {
      const hours = Number(p.get("hours")) || URL_DEFAULTS.hours;
      RANGE_PINNED = true;
      setRangeTs(now - hours * 3600, now); // bumpless: pinned windows re-anchor to now
    }
    document.getElementById("sort").value = p.get("sort") || URL_DEFAULTS.sort;
    document.getElementById("limit").value = p.get("limit") || URL_DEFAULTS.limit;
    document.getElementById("min_tokens").value = p.get("min_tokens") || URL_DEFAULTS.min_tokens;
    CAL_SELECTED = p.get("day") || null;
    const calYear = Number(p.get("cal_year"));
    if (calYear) CAL_YEAR = calYear;
    if (p.get("cal") === "1") openCal(); else closeCal();
    const sid = p.get("session");
    if (sid && sid !== MODAL_SID) openModal(sid);
    else if (!sid && MODAL_SID) closeModal();
  } finally {
    SUPPRESS_URL = false;
  }
  loadSessions();
}

window.addEventListener("popstate", applyUrlState);

// ---------- Daily AIC calendar ----------
// Year heatmap of total AIC per local day, fed by /api/daily_aic (disk-cached server side).
// Wide: one row per month (31 day columns). Narrow: classic 7-day week grids per month.
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let CAL_DAYS = {};                       // "YYYY-MM-DD" -> aic
let CAL_YEAR = new Date().getFullYear();
let CAL_SELECTED = null;                 // "YYYY-MM-DD" of the day currently filtered

function calKey(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

// Cells always use N.nk so small days don't render with more digits than big ones.
function fmtAicCell(v) { return (v / 1000).toFixed(1) + "k"; }

// GitHub-contribution-style green ramp; intensity ∝ sqrt(v/max) so mid days stay visible.
function calHeat(v, max) {
  if (!v || max <= 0) return { bg: "var(--row)", fg: "#8b949e" };
  const t = Math.sqrt(Math.min(1, v / max));
  const ramp = ["#0e4429", "#006d32", "#26a641", "#39d353"];
  const i = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
  return { bg: ramp[i], fg: i >= 2 ? "#04260f" : "#e6f4ea" };
}

function calCell(y, m, d, max, today) {
  const key = calKey(y, m, d);
  const v = CAL_DAYS[key] || 0;
  const { bg, fg } = calHeat(v, max);
  const cls = ["cal-cell"];
  if (key === today) cls.push("today");
  if (key === CAL_SELECTED) cls.push("selected");
  // zero-AIC days are inert: no data-date (click delegation skips), no hover affordance
  if (!v) {
    return `<div class="${cls.join(" ")}" style="background:${bg}"><span class="d">${d}</span></div>`;
  }
  const title = `${MONTH_NAMES[m]} ${d}, ${y} · ${fmtAic(v)} AIC`;
  return `<div class="${cls.join(" ")}" data-date="${key}" title="${title}" style="background:${bg}">` +
    `<span class="d">${d}</span>` +
    `<span class="v" style="color:${fg}">${fmtAicCell(v)}</span>` +
    `</div>`;
}

function renderCalendar() {
  const el = document.getElementById("calendar");
  const y = CAL_YEAR;
  const today = calKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  let max = 0, yearTotal = 0;
  for (const [k, v] of Object.entries(CAL_DAYS)) {
    if (!k.startsWith(`${y}-`)) continue;
    yearTotal += v;
    if (v > max) max = v;
  }
  document.getElementById("calYear").textContent = String(y);
  document.getElementById("calInfo").textContent = yearTotal ? `· ${fmtAic(yearTotal)} AIC this year` : "· no AIC this year";

  // month-per-row needs ~26px × 31 cells + label; below that fall back to 7-day weeks
  const wide = el.clientWidth >= 860;
  let html = "";
  if (wide) {
    html += `<div class="cal-months">`;
    for (let m = 0; m < 12; m++) {
      const nDays = new Date(y, m + 1, 0).getDate();
      html += `<div class="cal-mlabel">${MONTH_NAMES[m]}</div>`;
      for (let d = 1; d <= 31; d++) {
        html += d <= nDays ? calCell(y, m, d, max, today) : `<div class="cal-cell blank"></div>`;
      }
    }
    html += `</div>`;
  } else {
    html += `<div class="cal-weeks">`;
    for (let m = 0; m < 12; m++) {
      const nDays = new Date(y, m + 1, 0).getDate();
      const offset = new Date(y, m, 1).getDay(); // 0 = Sunday
      html += `<div class="cal-month-block"><div class="cal-mlabel">${MONTH_NAMES[m]}</div><div class="cal-week-grid">`;
      for (let i = 0; i < offset; i++) html += `<div class="cal-cell blank"></div>`;
      for (let d = 1; d <= nDays; d++) html += calCell(y, m, d, max, today);
      html += `</div></div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

async function loadCalendar() {
  try {
    const resp = await fetch("/api/daily_aic");
    const data = await resp.json();
    CAL_DAYS = data.days || {};
    // default to the most recent year that has data (usually current year)
    const years = Object.keys(CAL_DAYS).map(k => Number(k.slice(0, 4)));
    if (years.length && !years.includes(CAL_YEAR)) CAL_YEAR = Math.max(...years);
    renderCalendar();
  } catch (e) {
    document.getElementById("calendar").innerHTML = `<div class="muted" style="padding:8px">failed to load daily AIC</div>`;
  }
}

// Popover plumbing — the calendar acts as an advanced date picker off the controls bar.
const calPop = document.getElementById("calPop");
const calTrigger = document.getElementById("calTrigger");
let _calLoaded = false;

function openCal() {
  calPop.hidden = false;
  calTrigger.classList.add("active");
  if (!_calLoaded) { _calLoaded = true; loadCalendar(); }
  else renderCalendar(); // re-measure width / refresh selection
  syncUrl();
}
function closeCal() {
  const wasOpen = !calPop.hidden;
  calPop.hidden = true;
  calTrigger.classList.remove("active");
  if (wasOpen) syncUrl();
}
calTrigger.addEventListener("click", () => (calPop.hidden ? openCal() : closeCal()));
document.addEventListener("click", e => {
  if (!calPop.hidden && !calPop.contains(e.target) && e.target !== calTrigger) closeCal();
});

document.getElementById("calendar").addEventListener("click", e => {
  const cell = e.target.closest(".cal-cell[data-date]");
  if (!cell) return;
  const key = cell.dataset.date;
  const [yy, mm, dd] = key.split("-").map(Number);
  const start = Math.floor(new Date(yy, mm - 1, dd).getTime() / 1000);
  CAL_SELECTED = key;
  closeCal();
  RANGE_PINNED = false;
  setRangeTs(start, start + 86400);
  loadSessions();
});
document.getElementById("calPrevYear").addEventListener("click", () => { CAL_YEAR--; renderCalendar(); syncUrl(); });
document.getElementById("calNextYear").addEventListener("click", () => { CAL_YEAR++; renderCalendar(); syncUrl(); });

let _calResizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(_calResizeT);
  _calResizeT = setTimeout(() => { if (!calPop.hidden) renderCalendar(); }, 150);
});

// ---------- Main load ----------
let CURRENT_MAX_TOK = 0;

async function loadSessions() {
  const [s, e] = getRangeTs();
  // drop the calendar highlight if the range no longer matches the selected day
  if (CAL_SELECTED) {
    const [yy, mm, dd] = CAL_SELECTED.split("-").map(Number);
    const dayStart = Math.floor(new Date(yy, mm - 1, dd).getTime() / 1000);
    if (s !== dayStart || e !== dayStart + 86400) {
      CAL_SELECTED = null;
      renderCalendar();
    }
  }
  const opts = new URLSearchParams({
    sort: document.getElementById("sort").value,
    limit: document.getElementById("limit").value,
    min_tokens: document.getElementById("min_tokens").value,
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

  const tot_in = data.sessions.reduce((s, x) => s + x.total_input, 0);
  const tot_cached = data.sessions.reduce((s, x) => s + x.total_cached, 0);
  const tot_req = data.sessions.reduce((s, x) => s + x.n_requests, 0);
  const tot_aic = data.sessions.reduce((s, x) => s + (x.total_aic || 0), 0);
  document.getElementById("banner-stats").textContent =
    `· ${data.sessions.length} sessions · ${fmt(tot_req)} reqs · ${fmt(tot_in)} input · ${tot_in ? Math.round(100 * tot_cached / tot_in) : 0}% cached · ${fmtAic(tot_aic)} AIC · shared y-max ${fmt(maxTok)}`;
  document.getElementById("took").textContent = `(${data.took_ms} ms scan)`;

  if (data.sessions.length === 0) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }

  grid.innerHTML = data.sessions.map(s =>
    `<div class="card" data-sid="${escapeHtml(s.sid)}">${renderChart(s, { maxTok })}</div>`
  ).join("");
  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(card.dataset.sid, maxTok));
  });
}

document.getElementById("controls").addEventListener("submit", e => {
  e.preventDefault();
  // Refresh means "show everything on disk right now": re-anchor a pinned
  // ("last N hours") window to now so sessions started since the last load are
  // included. (Sessions are matched by lifetime overlap, so still-active
  // sessions remain visible even in windows whose end is in the past.)
  const [s, en] = getRangeTs();
  if (RANGE_PINNED && s && en) {
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
applyUrlState();
