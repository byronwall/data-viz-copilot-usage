// Copilot usage viewer frontend.
// Charts are SVG, rendered client-side from session payloads so filtering is responsive.

const PALETTE = ["#a371f7", "#3fb950", "#ff7b72", "#f0883e", "#79c0ff", "#ffa657", "#d2a8ff", "#56d364"];

function fmt(n) { return Number(n || 0).toLocaleString(); }

// ---------- Quantity abbreviation ----------
// Big token counts get noisy when shown in full (3,893,592). qty()/qtySvg() collapse
// them to a short value + unit suffix (3.89M, 222k) and tint the suffix so the magnitude
// reads at a glance — k is muted gray, M (the bigger numbers) gets a brighter accent.
const QTY_UNIT_COLOR = { k: "#768390", M: "#d2a8ff" };
function qtyParts(n) {
  n = Number(n || 0);
  const a = Math.abs(n);
  if (a >= 1e6) return { num: (n / 1e6).toFixed(2).replace(/\.?0+$/, ""), unit: "M" };
  if (a >= 1e3) return { num: String(Math.round(n / 1e3)), unit: "k" };
  return { num: String(Math.round(n)), unit: "" };
}
// HTML form (uses .q-k / .q-m classes from style.css for the suffix tint).
function qty(n) {
  const { num, unit } = qtyParts(n);
  return unit ? `${num}<span class="q-${unit}">${unit}</span>` : num;
}
// SVG form — suffix is an inline-filled <tspan> so it works inside chart <text> nodes.
function qtySvg(n) {
  const { num, unit } = qtyParts(n);
  return unit ? `${num}<tspan fill="${QTY_UNIT_COLOR[unit]}">${unit}</tspan>` : num;
}
// Plain-text form (no markup) for textContent contexts.
function qtyText(n) { const { num, unit } = qtyParts(n); return num + unit; }

// ---------- Cost unit (global) ----------
// All cost figures are stored as AIC (Copilot credits). The UNIT toggle re-expresses
// them as US dollars at the fixed 100 AIC = $1 rate. fmtAic() returns the bare number
// in the active unit; fmtCost() wraps it with the unit ($-prefix for USD, " AIC" suffix
// otherwise); unitLabel() is the standalone symbol for column/section headers.
let UNIT = "aic"; // "aic" | "usd"
function unitLabel() { return UNIT === "usd" ? "$" : "AIC"; }
function aicConvert(n) { return UNIT === "usd" ? Number(n || 0) / 100 : Number(n || 0); }
function fmtAic(n) {
  const v = aicConvert(n);
  const usd = UNIT === "usd";
  if (v === 0) return "0";
  if (Math.abs(v) < 1000) return usd ? v.toFixed(2) : v.toFixed(1);  // one decimal, like VS Code's credit badge
  if (Math.abs(v) < 1e6) return (v / 1000).toFixed(usd ? 2 : 1) + "k";
  return (v / 1e6).toFixed(2) + "M";
}
function fmtCost(n) { return UNIT === "usd" ? "$" + fmtAic(n) : fmtAic(n) + " AIC"; }
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
// User-message turns are the human's own input — the moments a person actually
// typed something — so they get a distinct gold star drawn ON TOP of every other
// marker (see the star pass at the end of renderChart's marker drawing).
const USER_MSG_COLOR = "#ffd33d";
function starPoints(cx, cy, R) {
  const inner = R * 0.45;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : inner;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(" ");
}
// Reasoning EFFORT level pill (not a token count — VS Code folds reasoning tokens into
// output). Colored low→high so different reasoning levels are visually comparable at a glance.
const REASONING_COLORS = { minimal: "#6e7681", low: "#3fb950", medium: "#d29922", high: "#ff9a3c", xhigh: "#f85149" };
function reasoningBadge(r) {
  if (!r) return `<span class="rsn-none">—</span>`;
  // mixed levels ("medium·xhigh") render each as its own chip
  return String(r).split("·").map(part => {
    const col = REASONING_COLORS[part] || "#a371f7"; // think:* / unknown → purple
    return `<span class="rsn" style="--rc:${col}">${escapeHtml(part)}</span>`;
  }).join(" ");
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

  // user-message stars (drawn LAST so they sit on top of every dot/line/diamond).
  // These are the human's own prompts — the most important points on the chart.
  const starR = big ? 8.5 : 5.5;
  const starSW = big ? 1.4 : 1;
  for (const c of mainNonCompact) {
    if (!c.user) continue;
    const x = X(c.t), y = Y(c.cum);
    const attr = interactive ? ` class="dot" data-idx="P-${c.idx}"` : "";
    svg += `<polygon points="${starPoints(x, y, starR)}" fill="${USER_MSG_COLOR}" stroke="#0e1116" stroke-width="${starSW}" stroke-linejoin="round"${attr}/>`;
  }
  (payload.kids || []).forEach((k, i) => {
    for (const c of k.calls) {
      if (!c.user || c.compact || c.err) continue;
      const x = X(c.t), y = Y(c.cum_offset);
      const attr = interactive ? ` class="dot" data-idx="K${i}-${c.idx}"` : "";
      svg += `<polygon points="${starPoints(x, y, starR * 0.85)}" fill="${USER_MSG_COLOR}" stroke="#0e1116" stroke-width="${starSW}" stroke-linejoin="round"${attr}/>`;
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
  // Row 1: date + input + uncached — the headline "how big was it" fields.
  // Kept short so the line fits inside the narrow (360px) grid cards.
  const hdr_uncached = (payload.total_input || 0) - (payload.total_cached || 0);
  let row1 = `<text x="6" y="${big ? 16 : 14}" fill="#c9d1d9" font-size="${fs1}" font-weight="600">${escapeHtml(date)} · <tspan fill="#c9d1d9">${qtySvg(payload.total_input)}</tspan> in · <tspan fill="#f85149">${qtySvg(hdr_uncached)}</tspan> uncached</text>`;
  // Row 2: output + cache% + AIC (the rest of the totals) followed by turn structure
  // (reqs, subs, compactions, linkage chips). Overflow from row 1 lands here so it all fits.
  let row2parts = [`<tspan fill="#c9d1d9">${qtySvg(payload.total_output)}</tspan> out`];
  row2parts.push(`<tspan fill="${cp >= 70 ? "#58a6ff" : cp >= 30 ? "#d29922" : "#f85149"}">${cp}%</tspan> cache`);
  if (payload.total_aic > 0) row2parts.push(`<tspan fill="#56d364">${fmtCost(payload.total_aic)}</tspan>`);
  row2parts.push(`${nReq} req`);
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
  // The primary agent is whichever debugName dominates the non-compaction turns: that's
  // panel/editAgent for a normal session, but searchSubagentTool for a search-subagent
  // session opened on its own (so we don't hardcode it and lose the line for those).
  // Also drop failed requests (status:error) — they report 0 input tokens.
  const realMain = (payload.main || []).filter(c => !c.err && !c.compact);
  const dbgCounts = {};
  for (const c of realMain) dbgCounts[c.dbg] = (dbgCounts[c.dbg] || 0) + 1;
  const primaryDbg = Object.entries(dbgCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const mainTurns = (payload.main || []).filter(c => (payload._all_turns || c.dbg === primaryDbg) && !c.err);
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

  // user-message stars in the per-turn band too (on top of the small dots)
  const subStarR = big ? 5 : 3.4;
  for (const c of mainTurns) {
    if (!c.user) continue;
    svg += `<polygon points="${starPoints(X(c.t), subY(c.input), subStarR)}" fill="${USER_MSG_COLOR}" stroke="#0e1116" stroke-width="${big ? 1 : 0.7}" stroke-linejoin="round"/>`;
  }
  (payload.kids || []).forEach(k => {
    for (const c of k.calls) {
      if (!c.user || c.err) continue;
      svg += `<polygon points="${starPoints(X(c.t), subY(c.input), subStarR)}" fill="${USER_MSG_COLOR}" stroke="#0e1116" stroke-width="${big ? 1 : 0.7}" stroke-linejoin="round"/>`;
    }
  });

  // Footer: first user message
  const title = escapeHtml((payload.first_user || "(no user msg)").slice(0, big ? 110 : 70));
  svg += `<text x="6" y="${h - 4}" fill="#7d8590" font-size="${big ? 11 : 9}">${title}</text>`;
  svg += "</svg>";
  return svg;
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
    <div class="modal-meta">${escapeHtml(payload.sid)} · ws ${escapeHtml(payload.workspace || "")} · ${new Date(payload.last_event_ts || payload.mtime * 1000).toLocaleString()} · model ${escapeHtml(payload.top_model)}${payload.reasoning ? ` · reasoning ${reasoningBadge(payload.reasoning)}` : ""}</div>
    <div class="modal-prompt">${escapeHtml(payload.first_user || "(no user message)")}</div>
    ${linkChip}
    <div class="modal-totals">
      <span>input <b>${qty(total_in)}</b></span>
      <span>cached <b style="color:#58a6ff">${qty(total_cached)}</b> (${total_in ? Math.round(100 * total_cached / total_in) : 0}%)</span>
      <span>uncached <b style="color:#f85149">${qty(total_uncached)}</b></span>
      <span>output <b>${qty(total_out)}</b></span>
      <span>${unitLabel()} <b style="color:#56d364">${fmtAic(total_aic)}</b></span>
      <span>turns <b>${all.length}</b></span>
      <span>compactions <b style="color:#ff9a3c">${compactCalls.length}</b> (${fmt(compact_total)} tok)</span>
      <span>duration <b>${hms(payload.duration_ms)}</b></span>
    </div>
  </div>
  <table class="calls">
    <thead><tr>
      <th>#</th><th>t</th><th>debugName</th><th>rsn</th>
      <th class="num">input</th><th class="num">cached</th><th class="num">uncached</th>
      <th class="num">out</th><th class="num">${unitLabel()}</th><th>tool calls</th>
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
        const modelTag = km && km.top_model && km.top_model !== "?"
          ? ` · <span class="t-model">${escapeHtml(km.top_model)}</span>` : "";
        if (km && km.is_search_child) {
          // Render inline, identical structure to a regular sub-agent section — no jump.
          label = `<span style="color:#79c0ff">🔍 search-subagent</span> · ${escapeHtml(km.child_sid ? km.child_sid.slice(0, 8) : "")}${modelTag}`;
        } else {
          label = `▸ sub-agent: ${escapeHtml(c._label || curGrp)}${modelTag}`;
        }
      } else {
        label = `▸ foreground (panel/editAgent)`;
      }
      html += `<tr class="kid-section"><td colspan="10">${label}</td></tr>`;
    }
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
      <td>${reasoningBadge(c.reasoning)}</td>
      <td class="num">${fmt(c.input)}</td>
      <td class="num cached">${fmt(c.cached)}</td>
      <td class="num">${c.err ? `<span style="color:#f85149">${escapeHtml((c.err_msg || "failed").slice(0, 48))}</span>` : `<span class="uncached">${fmt(c.input - c.cached)}</span>`}</td>
      <td class="num">${fmt(c.output)}</td>
      <td class="num aic">${c.aic ? fmtAic(c.aic) : "<span style='color:#444'>—</span>"}</td>
      <td>${toolSummary}</td>
    </tr>`;
    if (tools.length > 0) {
      html += `<tr class="tools collapsed"><td colspan="10"><div class="tools-inner">`;
      tools.forEach(t => {
        const dur = t.d > 0 ? `<span class="dur">${t.d}ms</span>` : "";
        const summary = summarizeArgs(t.a || "");
        let detail = renderValue(t.a || "");
        if (t.res) detail += `<div class="res"><span class="reslbl">result</span><div class="res-body clamped">${renderValue(t.res)}</div><button class="res-toggle" type="button">show more</button></div>`;
        const copyText = String(t.a ?? "") + (t.res ? `\n\n--- result ---\n${t.res}` : "");
        const copyAttr = encodeURIComponent(copyText);
        html += `<div class="tool"><div class="tool-head"><span class="caret">▸</span><span class="nm">${escapeHtml(t.n)}</span><button class="copy-btn" type="button" data-copy="${copyAttr}" title="Copy full message to clipboard">copy</button>${dur}<span class="summary">${escapeHtml(summary)}</span></div><div class="tool-detail collapsed">${detail}</div></div>`;
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
    <span><span class="star"></span>user message</span>
    <span><span class="dot" style="background:#58a6ff"></span>foreground</span>
    <span><span class="dot" style="background:#a371f7"></span>sub-agent (dashed)</span>
    <span><span class="dia"></span>compaction</span>
    <span><span class="dot" style="background:#d29922"></span>med cache</span>
    <span><span class="dot" style="background:#f85149"></span>cold cache</span>
    <span class="muted">click a dot or row to select</span>`;
  wireSelect(chartHolder.querySelector("svg"), right);
  wireExpand(right);
  stickCallsHeader(right);
}

// The per-turn table's column header sticks below the (also-sticky) modal-header.
// Its height is dynamic (prompt length, wrapped totals), so measure it and expose
// the offset as a CSS var the th's `top` reads.
function stickCallsHeader(scrollEl) {
  const hdr = scrollEl.querySelector(".modal-header");
  if (hdr) scrollEl.style.setProperty("--calls-th-top", hdr.offsetHeight + "px");
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
  if (MODAL_SID) { MODAL_SID = null; syncUrl(true); }
}
document.getElementById("closeBtn").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); closeCal(); closeHelp(); } });

// ---------- Help / guided tour ----------
// A self-contained demo session (one main agent + one sub-agent + one 🔍 search-subagent),
// rendered with the real renderChart/renderDetail so the explanation always matches the UI.
// Fixed timestamps keep the demo deterministic.
const DEMO_END_TS = new Date("2026-06-04T14:32:00").getTime();
function _demoTool(n, a, res, d) { return { n, a, res: res || "", d: d || 0, s: "success", t: 0 }; }

function buildDemoPayload() {
  const main = [
    { t: 0, input: 2000, cached: 0, output: 420, dbg: "panel/editAgent", reasoning: "medium", aic: 0.6,
      tools: [_demoTool("user_message", "Add JWT auth to the API and write tests for the middleware"),
              _demoTool("readFile", '{"filePath":"src/server.ts"}', "import express from 'express'\nconst app = express()\n// ...route registration", 11)] },
    { t: 42000, input: 7600, cached: 1800, output: 610, dbg: "panel/editAgent", reasoning: "medium", aic: 1.8,
      tools: [_demoTool("readFile", '{"filePath":"src/routes/api.ts"}', "router.get('/users', listUsers)\nrouter.post('/users', createUser)", 9),
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
const HELP_PINS = [
  { n: 1, x: 430, y: 13, title: "Cost summary", body: "Date · total input tokens · cache hit % · session cost. Cost shows in AIC credits or $ (toggle in the toolbar)." },
  { n: 2, x: 240, y: 32, title: "Turn structure", body: "Request count, <b>sub</b>-agents, <b>🔍</b> search-subagents, and <b>◆</b> compactions for this session." },
  { n: 3, x: 470, y: 150, title: "Foreground line", body: "Cumulative input tokens for the main agent. Steeper = tokens piling up fast (often a large or uncached turn)." },
  { n: 4, x: 297, y: 289, title: "Dot = one request", body: "Dot <b>size</b> ∝ that turn's input; dot <b>color</b> = cache hit rate (blue warm → amber → red cold)." },
  { n: 5, x: 335, y: 331, title: "Sub-agent (dashed)", body: "A spawned sub-agent gets its own dashed line and color, tracking its own running token total." },
  { n: 6, x: 516, y: 344, title: "🔍 Search-subagent", body: "Search sub-agents are blue & dashed; the small ring marks where it was spawned. Click through to its own session." },
  { n: 7, x: 380, y: 172, title: "◆ Compaction", body: "An orange diamond marks where the context was summarized to free up tokens — note the jump in cumulative input." },
  { n: 8, x: 300, y: 446, title: "Per-turn input band", body: "The lower band shows each turn's input in isolation (not cumulative), so you can spot the spikes that drove cost." },
  { n: 9, x: 251, y: 358, title: "⭐ User message", body: "A gold star marks a turn the <b>human kicked off</b> by typing a prompt. Stars are drawn on top of every other marker so the human's inputs always stand out — scan them to see the back-and-forth that shaped the session." },
];

const HELP_FEATURES = [
  { name: "Date range", key: "◀ ▶", desc: "Set an explicit start/end, or step the window backward/forward by its current span." },
  { name: "Quick ranges", key: "1h–90d", desc: "Jump to the last N hours/days ending now. Refresh re-anchors a quick range to the current time." },
  { name: "AIC calendar", key: "📅", desc: "A year heatmap of daily spend. Click a day to filter to it; switches between AIC and $ with the unit toggle." },
  { name: "Sort & limit", desc: "Order sessions by input, cost, recency, requests, or duration. Top-N and a min-token floor trim the list." },
  { name: "Charts ↔ Table", desc: "Same sessions as SVG small-multiples or a sortable rollup table. Click a column header to re-sort the table." },
  { name: "Combine sub-agents", desc: "Fold sub-agent tokens into their parent (default), or split each sub-agent out as its own independent row/card." },
  { name: "AIC ↔ $", desc: "Show cost as Copilot AIC credits or US dollars, at the fixed 100 AIC = $1 rate. Applies everywhere at once." },
  { name: "Detail modal", desc: "Click a card/row to open per-turn detail. Click a chart dot or table row to highlight the matching turn." },
  { name: "Shareable URL", desc: "Every control, the open calendar, and the open session are encoded in the URL — copy it to share the exact view." },
];

const HELP_COLORS = [
  { mark: `<span class="hc-star"></span>`, txt: "<b>⭐ User message</b> — a human prompt; gold star, always drawn on top" },
  { mark: `<span class="hc-swatch" style="background:#58a6ff"></span>`, txt: "<b>Foreground</b> agent (panel/editAgent) — solid line" },
  { mark: `<span class="hc-line" style="border-color:#a371f7"></span>`, txt: "<b>Sub-agent</b> — dashed, one color each" },
  { mark: `<span class="hc-line" style="border-color:#79c0ff;border-top-style:dashed"></span>`, txt: "<b>🔍 search-subagent</b> — dashed blue + spawn ring" },
  { mark: `<span class="hc-dia"></span>`, txt: "<b>Compaction</b> — context was summarized" },
  { mark: `<span class="hc-swatch" style="background:#58a6ff"></span>`, txt: "<b>Warm cache</b> — &gt;70% of input was cached" },
  { mark: `<span class="hc-swatch" style="background:#d29922"></span>`, txt: "<b>Medium cache</b> — 30–70% cached" },
  { mark: `<span class="hc-swatch" style="background:#f85149"></span>`, txt: "<b>Cold cache</b> — &lt;30% cached (most expensive)" },
  { mark: `<span class="rsn" style="--rc:#d29922">med</span>`, txt: "<b>Reasoning effort</b> pill — requested level, not a token count" },
];

let HELP_OPEN = false;

function renderHelp() {
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

  // Static reference cards.
  document.getElementById("helpFeatures").innerHTML = HELP_FEATURES.map(f =>
    `<div class="help-feature"><div class="hf-name">${escapeHtml(f.name)}${f.key ? `<span class="hf-key">${escapeHtml(f.key)}</span>` : ""}</div><div class="hf-desc">${f.desc}</div></div>`
  ).join("");
  document.getElementById("helpColors").innerHTML = HELP_COLORS.map(c =>
    `<div class="help-color"><span class="hc-mark">${c.mark}</span><span class="hc-txt">${c.txt}</span></div>`
  ).join("");
}

function openHelp() {
  if (HELP_OPEN) return;
  HELP_OPEN = true;
  renderHelp();
  document.getElementById("helpModal").classList.add("open");
  syncUrl(true);
}
function closeHelp() {
  if (!HELP_OPEN) return;
  HELP_OPEN = false;
  document.getElementById("helpModal").classList.remove("open");
  syncUrl(true);
}
document.getElementById("helpBtn").addEventListener("click", openHelp);
document.getElementById("helpCloseBtn").addEventListener("click", closeHelp);
document.getElementById("helpModal").addEventListener("click", e => { if (e.target.id === "helpModal") closeHelp(); });

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
const URL_DEFAULTS = { hours: 24, sort: "total_input", limit: "50", min_tokens: "0", view: "charts", combine: "1", unit: "aic" };
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
  if (VIEW !== URL_DEFAULTS.view) p.set("view", VIEW);
  if (!COMBINE) p.set("combine", "0");
  if (UNIT !== URL_DEFAULTS.unit) p.set("unit", UNIT);
  if (CAL_SELECTED) p.set("day", CAL_SELECTED);
  if (!calPop.hidden) { p.set("cal", "1"); p.set("cal_year", String(CAL_YEAR)); }
  if (MODAL_SID) p.set("session", MODAL_SID);
  if (HELP_OPEN) p.set("help", "1");
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
    VIEW = p.get("view") === "table" ? "table" : "charts";
    COMBINE = p.get("combine") !== "0";
    UNIT = p.get("unit") === "usd" ? "usd" : "aic";
    CAL_SELECTED = p.get("day") || null;
    const calYear = Number(p.get("cal_year"));
    if (calYear) CAL_YEAR = calYear;
    if (p.get("cal") === "1") openCal(); else closeCal();
    const sid = p.get("session");
    if (sid && sid !== MODAL_SID) openModal(sid);
    else if (!sid && MODAL_SID) closeModal();
    if (p.get("help") === "1") openHelp(); else closeHelp();
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
function fmtAicCell(v) {
  const x = aicConvert(v);
  if (UNIT === "usd") return "$" + (x >= 1000 ? (x / 1000).toFixed(1) + "k" : Math.round(x));
  return (x / 1000).toFixed(1) + "k";
}

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
  const title = `${MONTH_NAMES[m]} ${d}, ${y} · ${fmtCost(v)}`;
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
  document.getElementById("calInfo").textContent = yearTotal ? `· ${fmtCost(yearTotal)} this year` : `· no ${unitLabel()} this year`;

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
let LAST_SESSIONS = [];
let LAST_DISPLAY = [];     // what's actually on screen (combined or expanded)
let LAST_MAXTOK = 1000;
let VIEW = "charts";
// true → sub-agent (sub-agent + search-subagent) tokens stay folded into their parent (default).
// false → each sub-agent is split out as its own row/card, with its tokens removed from the parent.
let COMBINE = true;
// Column sort for the table view. key=null → keep the server's sort (the controls' sort key).
let TABLE_SORT = { key: null, dir: -1 };

// Sum a sub-agent's per-turn tokens (the contribution it added to its parent's totals).
function kidTotals(k) {
  let input = 0, cached = 0, output = 0, aic = 0, nc = 0;
  for (const c of k.calls) {
    input += c.input || 0; cached += c.cached || 0; output += c.output || 0;
    aic += c.aic || 0; if (c.compact) nc++;
  }
  return { input, cached, output, aic, n: k.calls.length, nc };
}

function kidReasoning(k) {
  return [...new Set(k.calls.map(c => c.reasoning).filter(Boolean))].join("·");
}

// Expand each session into (parent-minus-its-sub-agents) + one standalone entry per sub-agent.
// Synthetic entries carry every field the table/chart renderers read, plus `_modal_sid` so a
// click routes to a real session detail (the search-subagent's own session, else the parent).
function expandSessions(sessions) {
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

function displaySessions() {
  return COMBINE
    ? LAST_SESSIONS.map(s => ({ ...s, _modal_sid: s.sid, n_subs: (s.kids || []).length }))
    : expandSessions(LAST_SESSIONS);
}

function renderCards(sessions, maxTok) {
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
const uncachedTok = s => (s.total_input || 0) - (s.total_cached || 0);
const TABLE_COLS = [
  { key: "time", label: "time", num: false, get: s => s.last_event_ts || s.mtime * 1000,
    render: s => `<span class="t-time">${new Date(s.last_event_ts || s.mtime * 1000).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>` },
  { key: "model", label: "model", num: false, get: s => s.top_model || "",
    render: s => `<span class="t-model">${escapeHtml(s.top_model || "?")}</span>` },
  { key: "reasoning", label: "reasoning", num: false, get: s => s.reasoning || "",
    render: s => reasoningBadge(s.reasoning) },
  { key: "thread", label: "thread (first user message)", num: false, get: s => (s.first_user || "").toLowerCase(),
    render: s => `<span class="t-thread">${escapeHtml(s.first_user || "(no user message)")}</span>` },
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

function renderTable(sessions, maxTok) {
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
    const label = c.key === "total_aic" ? unitLabel() : c.label;
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
function updateBanner() {
  const ss = LAST_SESSIONS || [];
  const tot_in = ss.reduce((s, x) => s + x.total_input, 0);
  const tot_cached = ss.reduce((s, x) => s + x.total_cached, 0);
  const tot_req = ss.reduce((s, x) => s + x.n_requests, 0);
  const tot_aic = ss.reduce((s, x) => s + (x.total_aic || 0), 0);
  document.getElementById("banner-stats").textContent =
    `· ${ss.length} sessions · ${fmt(tot_req)} reqs · ${qtyText(tot_in)} input · ${tot_in ? Math.round(100 * tot_cached / tot_in) : 0}% cached · ${fmtCost(tot_aic)} · shared y-max ${qtyText(LAST_MAXTOK)}`;
}

// Re-express every cost figure on screen in the active unit (AIC or $).
function applyUnit() {
  document.querySelectorAll(".unit-btn").forEach(b => b.classList.toggle("active", b.dataset.unit === UNIT));
  const calBtn = document.getElementById("calTrigger");
  if (calBtn) calBtn.textContent = `📅 ${unitLabel()}`;
  updateBanner();
  if (LAST_SESSIONS.length) applyView();
  if (!calPop.hidden) renderCalendar();
  if (MODAL_SID) openModal(MODAL_SID);
}

function applyView() {
  const charts = VIEW !== "table";
  document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", (b.dataset.view === "table") !== charts));
  document.querySelectorAll(".combine-btn").forEach(b => b.classList.toggle("active", (b.dataset.combine === "1") === COMBINE));
  document.querySelectorAll(".unit-btn").forEach(b => b.classList.toggle("active", b.dataset.unit === UNIT));
  document.getElementById("calTrigger").textContent = `📅 ${unitLabel()}`;
  document.getElementById("grid").hidden = !charts;
  document.getElementById("tableWrap").hidden = charts;
  if (!LAST_SESSIONS.length) return;
  LAST_DISPLAY = displaySessions();
  if (charts) renderCards(LAST_DISPLAY, LAST_MAXTOK);
  else renderTable(LAST_DISPLAY, LAST_MAXTOK);
}

document.querySelectorAll(".view-btn").forEach(b => {
  b.addEventListener("click", () => {
    if (VIEW === b.dataset.view) return;
    VIEW = b.dataset.view;
    syncUrl();
    applyView();
  });
});

document.querySelectorAll(".combine-btn").forEach(b => {
  b.addEventListener("click", () => {
    const v = b.dataset.combine === "1";
    if (COMBINE === v) return;
    COMBINE = v;
    syncUrl();
    applyView();
  });
});

document.querySelectorAll(".unit-btn").forEach(b => {
  b.addEventListener("click", () => {
    if (UNIT === b.dataset.unit) return;
    UNIT = b.dataset.unit;
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
