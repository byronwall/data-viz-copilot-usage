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

// One tool call's collapsible block: a one-line head (name + arg gist + duration +
// copy) that expands to the full args (and result, if any). Shared by the per-turn
// table and the by-tool aggregate view so both render tool params identically.
function toolBlockHtml(t) {
  const dur = t.d > 0 ? `<span class="dur">${t.d}ms</span>` : "";
  const summary = summarizeArgs(t.a || "");
  let detail = renderValue(t.a || "");
  if (t.res) detail += `<div class="res"><span class="reslbl">result</span><div class="res-body clamped">${renderValue(t.res)}</div><button class="res-toggle" type="button">show more</button></div>`;
  const copyAttr = encodeURIComponent(String(t.a ?? "") + (t.res ? `\n\n--- result ---\n${t.res}` : ""));
  return `<div class="tool"><div class="tool-head"><span class="caret">▸</span><span class="nm">${escapeHtml(t.n)}</span><button class="copy-btn" type="button" data-copy="${copyAttr}" title="Copy full message to clipboard">copy</button>${dur}<span class="summary">${escapeHtml(summary)}</span></div><div class="tool-detail collapsed">${detail}</div></div>`;
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
    <div class="view-toggle dview-toggle">
      <button type="button" class="dview-btn active" data-dview="turns">turns</button>
      <button type="button" class="dview-btn" data-dview="tools">by tool</button>
      <button type="button" class="dview-btn" data-dview="files">by file</button>
    </div>
  </div>
  <div class="dview" data-dview="turns">
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
      tools.forEach(t => { html += toolBlockHtml(t); });
      html += `</div></td></tr>`;
    }
  });
  html += "</tbody></table></div>";
  html += `<div class="dview" data-dview="tools" hidden>${renderToolAgg(payload)}</div>`;
  html += `<div class="dview" data-dview="files" hidden>${renderFileAgg(payload)}</div>`;
  return html;
}

// ---------- "By tool" aggregate view ----------
// Rolls token usage up by the tool a request invoked. "new input" is each request's
// input delta vs. the previous request in the SAME agent (foreground or a given
// sub-agent), since each agent grows its own context. A request's metrics are
// attributed to every distinct tool it called, so a request that invokes several
// tools is counted under each — column totals can therefore exceed the (honest)
// session totals shown above the table. Requests with no tools fall into a
// "(no tool call)" bucket so compactions and the like are still accounted for.
const NO_TOOL = "(no tool call)";

function computeToolAgg(payload) {
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
    if (!b) { b = { name, callers: new Map(), sumNew: 0, sumUncached: 0, sumOut: 0, sumAic: 0, uses: 0 }; buckets.set(name, b); }
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
          caller = { ...meta, instances: [] };
          b.callers.set(callKey, caller);
          b.sumNew += meta.newInput; b.sumUncached += meta.uncached; b.sumOut += meta.out; b.sumAic += meta.aic;
        }
        if (nm === NO_TOOL) { b.uses += 1; return; }
        const insts = tools.filter(t => (t.n || "?") === nm);
        insts.forEach(t => { caller.instances.push(t); b.uses += 1; });
      });
    });
  });

  const list = [...buckets.values()].map(b => ({
    name: b.name,
    nCallers: b.callers.size,
    uses: b.uses,
    sumNew: b.sumNew, sumUncached: b.sumUncached, sumOut: b.sumOut, sumAic: b.sumAic,
    callers: [...b.callers.values()].sort((a, z) => z.aic - a.aic),
  })).sort((a, z) => z.sumAic - a.sumAic);

  const totalAic = payload.total_aic != null ? payload.total_aic : list.reduce((s, b) => s + b.sumAic, 0);
  return { list, totalNew, totalUncached, totalOut: payload.total_output || 0, totalAic };
}

// Pull a file path out of a tool's args JSON, trying the keys various tools use.
function toolFilePath(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] === "{") {
    try {
      const o = JSON.parse(s);
      return o.filePath || o.path || o.file || o.target_file || o.absolute_path || o.relativePath || "";
    } catch (_) { /* not json */ }
  }
  return "";
}

// A short "what part of the file" hint from read args (line range / offset+limit).
function fileRange(argStr) {
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
function parseRange(argStr) {
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
const HEAT_SCALE = ["#1f6feb", "#2f9e44", "#e3b341", "#f0883e", "#f85149"];
function heatColor(n) {
  if (n <= 0) return "#161b22";
  return HEAT_SCALE[Math.min(n, HEAT_SCALE.length) - 1];
}
// Build a stretched SVG strip across a file's line range; each segment colored by how
// many of the reads covered it. Returns the svg plus the file's max line and peak overlap.
function lineHeatStrip(spans, fixedMax) {
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
function guessRoot(paths) {
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
function underRoot(root, p) {
  p = String(p ?? "").replace(/\\/g, "/");
  return !!root && (p === root || p.startsWith(root + "/"));
}
function relTo(root, p) {
  p = String(p ?? "").replace(/\\/g, "/");
  return underRoot(root, p) ? p.slice(root.length).replace(/^\//, "") : p;
}

// Flatten a bucket's callers into one event per tool invocation (inst), carrying the
// owning request's metadata. Callers with no instances (e.g. compactions) yield one
// inst-less event so they still appear.
function bucketEvents(bucket) {
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
function readsPopover(rel, calls) {
  const rows = calls.map((c, i) =>
    `<tr><td class="num">${i + 1}</td><td>${hms(c.t)}</td><td class="rng">${escapeHtml(c.range || "full")}</td><td class="num">${c.resLen ? qtyText(c.resLen) + "c" : "—"}</td><td class="num">${c.dur ? c.dur + "ms" : ""}</td></tr>`
  ).join("");
  return `<span class="rcount-pop"><span class="rcp-head">${calls.length} reads of <b>${escapeHtml(rel)}</b></span>`
    + `<table class="rcp-tbl"><thead><tr><th class="num">#</th><th>time</th><th>range</th><th class="num">result</th><th class="num">dur</th></tr></thead><tbody>${rows}</tbody></table></span>`;
}

// Stable short agent identifier from a list of events, ordered by first-seen.
// Foreground gets "main"; 🔍 search sub-agents get "search N"; others get "sub N".
function stableAgentIdent(events) {
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
function agentBadgeHtml(id, grp) {
  if (!id) return `<span class="grp" title="${escapeHtml(grp || "")}">${escapeHtml(grp || "")}</span>`;
  return `<span class="agent-badge" title="${escapeHtml(grp || "")}"><i class="agent-swatch" style="background:${id.color}">${id.icon}</i><span class="agent-short">${escapeHtml(id.short)}</span></span>`;
}

// Dedicated read_file view: every read as a row, paths shown relative to a guessed
// root, sortable by name or time, each row expanding to full args + result.
function buildFilePanel(bucket, ul) {
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
  const reads = events.map((e, i) => ({ rel: rels[i], grp: e.grp, t: e.t || 0, span: e.inst ? parseRange(e.inst.a) : null })).filter(r => r.rel);
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
    const id = ident.get(e.grp);
    const srcKey = (id ? id.short : e.grp || "") + " " + (e.dbg || "");
    h += `<tr class="srow${exp}" data-ord="${ord}" data-t="${e.t || 0}" data-file="${escapeHtml(rel.toLowerCase())}" data-reads="${cnt || 0}" data-range="${escapeHtml(range.toLowerCase())}" data-res="${resLen}" data-dur="${dur}" data-src="${escapeHtml(srcKey.toLowerCase())}" data-aic="${e.aic || 0}">
      <td class="num">${ord + 1}</td>
      <td>${hms(e.t || 0)}</td>
      <td>${inst ? `<span class="caret">▸</span>` : ""}<span class="fpath${ext ? " ext" : ""}" title="${escapeHtml(paths[ei] || "")}">${ext ? "↗ " : ""}${escapeHtml(rel)}</span></td>
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
function agentIdentity(grps) {
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

function heatStripHtml(svg, maxLine) {
  return `<div class="heat-strip"><span class="heat-ax">1</span>${svg}<span class="heat-ax">${fmt(maxLine)}</span></div>`;
}

// Per-file line-coverage heatmap. Condensed by default: one combined strip per file
// (all agents merged). Files read by more than one agent are expandable — click to
// reveal a per-agent split (aligned to the same line scale), click again to collapse.
// A stable colored icon IDs each agent (swatches on the condensed row, full label in
// the split). Files are ordered by total read count (hottest first).
function buildLineHeatmap(reads) {
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
    if (!f) { f = { rel: r.rel, reads: 0, spans: [], byAgent: new Map() }; fileMap.set(r.rel, f); }
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

    h += `<div class="heat-file${expandable ? " expandable" : ""}" data-hf="${fi}">
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
function buildGenericPanel(bucket, ul) {
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
    const gist = inst ? (summarizeArgs(inst.a || "") || "—") : "(request)";
    const resLen = inst && inst.res ? inst.res.length : 0;
    const dur = inst ? (inst.d || 0) : 0;
    const exp = inst ? " expandable" : "";
    const id = ident.get(e.grp);
    const srcKey = (id ? id.short : e.grp || "") + " " + (e.dbg || "");
    h += `<tr class="srow${exp}" data-ord="${ord}" data-t="${e.t || 0}" data-gist="${escapeHtml(gist.toLowerCase())}" data-res="${resLen}" data-dur="${dur}" data-src="${escapeHtml(srcKey.toLowerCase())}" data-aic="${e.aic || 0}">
      <td class="num">${ord + 1}</td>
      <td>${hms(e.t || 0)}</td>
      <td>${inst ? `<span class="caret">▸</span>` : ""}<span class="fpath">${escapeHtml(gist)}</span></td>
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
function buildOverviewPanel(list, ul) {
  let h = `<table class="tagg"><thead><tr>
    <th>tool</th><th class="num">calls</th><th class="num">uses</th>
    <th class="num">new input</th><th class="num">uncached</th><th class="num">output</th><th class="num">${ul}</th>
  </tr></thead><tbody>`;
  if (!list.length) h += `<tr><td colspan="7" class="muted" style="padding:12px">no calls</td></tr>`;
  list.forEach((b, bi) => {
    h += `<tr class="tagg-tool expandable" data-k="t${bi}">
      <td><span class="caret">▸</span><span class="tnm">${escapeHtml(b.name)}</span></td>
      <td class="num">${b.nCallers}</td>
      <td class="num">${b.uses}</td>
      <td class="num">${fmt(b.sumNew)}</td>
      <td class="num uncached">${fmt(b.sumUncached)}</td>
      <td class="num">${fmt(b.sumOut)}</td>
      <td class="num aic">${b.sumAic ? fmtAic(b.sumAic) : "<span style='color:#444'>—</span>"}</td>
    </tr>`;
    h += `<tr class="tagg-sub collapsed"><td colspan="7"><div class="tagg-sub-inner"><table class="tagg-callers"><thead><tr>
      <th>t</th><th>source</th><th class="num">new input</th><th class="num">uncached</th><th class="num">output</th><th class="num">${ul}</th><th class="num">uses</th>
    </tr></thead><tbody>`;
    b.callers.forEach((c, ci) => {
      const hasParams = c.instances.length > 0;
      const dbgClass = c.compact ? "dbg compact" : "dbg";
      h += `<tr class="tagg-caller${hasParams ? " expandable" : ""}" data-k="t${bi}-c${ci}">
        <td>${hasParams ? `<span class="caret">▸</span>` : ""}${hms(c.t)}</td>
        <td class="${dbgClass}">${escapeHtml(c.dbg || "")}${c.err ? ` <span style="color:#f85149" title="${escapeHtml(c.errMsg || "request failed")}">✕</span>` : ""} <span class="grp">${escapeHtml(c.grp)}</span></td>
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

function renderToolAgg(payload) {
  const { list, totalNew, totalUncached, totalOut, totalAic } = computeToolAgg(payload);
  const ul = unitLabel();

  let h = `<div class="tagg-note"><b>new input</b> = each request's input delta vs. the previous request in the same agent (a shrunk context, e.g. just after a compaction, counts as 0). <b>uncached</b> = input − cached, i.e. the raw prompt size billed each request. Tokens are attributed to every tool a request invoked, so requests calling multiple tools are counted under each — column totals can exceed the session totals below.</div>`;
  h += `<div class="tagg-totals"><span>session new input <b>${qty(totalNew)}</b></span><span>uncached <b style="color:#f85149">${qty(totalUncached)}</b></span><span>output <b>${qty(totalOut)}</b></span><span>${ul} <b style="color:#56d364">${fmtAic(totalAic)}</b></span></div>`;

  // Segmented tabs: overview + one per tool, drilling into a dedicated per-tool view.
  let tabs = `<div class="tagg-tabs"><button type="button" class="tagg-tab active" data-tab="overview" data-name="overview">overview</button>`;
  list.forEach((b, bi) => { tabs += `<button type="button" class="tagg-tab" data-tab="t${bi}" data-name="${escapeHtml(b.name)}">${escapeHtml(b.name)} <span class="tcount">${b.uses}</span></button>`; });
  tabs += `</div>`;

  let panels = `<div class="tagg-panel" data-tab="overview">${buildOverviewPanel(list, ul)}</div>`;
  list.forEach((b, bi) => {
    const inner = b.name === "read_file" ? buildFilePanel(b, ul) : buildGenericPanel(b, ul);
    panels += `<div class="tagg-panel" data-tab="t${bi}" hidden>${inner}</div>`;
  });

  return h + tabs + panels;
}

// ---------- "By file" aggregate view ----------
// Groups every file-touching tool invocation (read_file, apply_patch, create_file,
// get_errors, …) by the file it acted on, so a session reads as "what got touched and
// how often" instead of turn-by-turn. A heatmap mode renders one line-coverage strip
// per ACTION per file, so you can see where in the file each kind of action landed.

// All file paths a tool invocation acted on. Extends toolFilePath to multi-file args
// (get_errors filePaths, runTests files) and apply_patch's inline patch headers.
function toolFilePaths(argStr) {
  const s = String(argStr ?? "").trim();
  if (s[0] !== "{") return [];
  let o;
  try { o = JSON.parse(s); } catch (_) { return []; }
  const single = o.filePath || o.path || o.file || o.target_file || o.absolute_path || o.relativePath;
  if (single) return [String(single)];
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
function collectFileEvents(payload) {
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
    paths.forEach(path => events.push({
      path, tool: t.n || "?", t: t.t != null ? t.t : c.t, grp: g.grp, dbg: c.dbg,
      span: parseRange(t.a), range: fileRange(t.a),
      resLen: t.res ? t.res.length : 0, dur: t.d || 0, inst: t,
    }));
  })));
  return { events, skipped };
}

// Stable color per action (tool name), assigned by frequency so the dominant actions
// get the first palette slots in every part of the view.
function toolColorMap(events) {
  const counts = new Map();
  events.forEach(e => counts.set(e.tool, (counts.get(e.tool) || 0) + 1));
  const names = [...counts.keys()].sort((a, z) => counts.get(z) - counts.get(a));
  const map = new Map();
  names.forEach((n, i) => map.set(n, PALETTE[i % PALETTE.length]));
  return map;
}

function toolChipHtml(name, count, col) {
  return `<span class="ftool-chip" style="--tc:${col}">${escapeHtml(name)}${count != null ? ` <b>${count}</b>` : ""}</span>`;
}

// File summary table: one row per file with per-action counts and a small-multiple
// strip showing WHICH line regions the actions covered (heat = same lines re-touched);
// a row expands to the full time-ordered list of every action on that file (args + result).
function buildFileAggTable(files, toolCol, ident) {
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
    h += `<tr class="srow expandable" data-ord="${fi}" data-file="${escapeHtml(f.rel.toLowerCase())}" data-n="${f.events.length}" data-tools="${escapeHtml(toolKey.toLowerCase())}" data-lines="${maxLine}" data-res="${f.res}" data-dur="${f.dur}" data-src="${escapeHtml([...f.agents].join(" ").toLowerCase())}">
      <td class="num">${fi + 1}</td>
      <td><span class="caret">▸</span><span class="fpath${f.ext ? " ext" : ""}" title="${escapeHtml(f.path)}">${f.ext ? "↗ " : ""}${escapeHtml(f.rel)}</span></td>
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
      inner += `<div class="fagg-evt"><span class="fagg-t">${hms(e.t)}</span>${toolChipHtml(e.tool, null, toolCol.get(e.tool))}${e.range ? `<span class="frange">${escapeHtml(e.range)}</span>` : ""}${agentBadgeHtml(id, e.grp)}</div>${toolBlockHtml(e.inst)}`;
    });
    h += `<tr class="srow-detail collapsed"><td colspan="8"><div class="tools-inner">${inner}</div></td></tr>`;
  });
  h += `</tbody></table>`;
  return h;
}

function renderFileAgg(payload) {
  const { events, skipped } = collectFileEvents(payload);
  if (!events.length) return `<div class="tagg-file-sub muted" style="padding:16px 12px">No file-touching tool calls in this session.</div>`;
  const root = guessRoot(events.map(e => e.path));
  events.forEach(e => { e.rel = relTo(root, e.path); e.ext = !underRoot(root, e.path); });
  const ident = stableAgentIdent(events);
  const toolCol = toolColorMap(events);

  const fileMap = new Map();
  events.forEach(e => {
    let f = fileMap.get(e.rel);
    if (!f) { f = { rel: e.rel, path: e.path, ext: e.ext, events: [], byTool: new Map(), agents: new Set(), res: 0, dur: 0 }; fileMap.set(e.rel, f); }
    f.events.push(e); f.agents.add(e.grp); f.res += e.resLen; f.dur += e.dur;
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

// Toggle between the per-turn table, by-tool, and by-file views inside the detail pane.
// The choice is global state (DVIEW, URL-persisted) so every session opens to the same view.
function wireDetailViews(rightEl) {
  const btns = [...rightEl.querySelectorAll(".dview-btn")];
  function activate(v, save) {
    const btn = btns.find(b => b.dataset.dview === v) || btns[0];
    if (!btn) return;
    btns.forEach(b => b.classList.toggle("active", b === btn));
    rightEl.querySelectorAll(".dview").forEach(d => { d.hidden = d.dataset.dview !== btn.dataset.dview; });
    if (save) { DVIEW = btn.dataset.dview; syncUrl(); }
  }
  btns.forEach(btn => btn.addEventListener("click", () => activate(btn.dataset.dview, true)));
  if (DVIEW !== "turns") activate(DVIEW, false);
}

// Progressive disclosure for the by-tool view: click a tool row to reveal its callers,
// click a caller row to reveal that tool's params/result. (The inner per-tool blocks
// reuse the same markup as the turns table, so wireExpand handles their second level.)
function wireToolAgg(rightEl) {
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
// The selected TOOL NAME (not index) persists via DTAB, so opening another session lands
// on the same tool's tab when that session has it (else overview).
function wireToolTabs(rightEl) {
  rightEl.querySelectorAll(".tagg-tabs").forEach(tabsEl => {
    const wrap = tabsEl.parentElement;
    const btns = [...tabsEl.querySelectorAll(".tagg-tab")];
    const panels = [...wrap.querySelectorAll(".tagg-panel")];
    function activate(btn, save) {
      const tab = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle("active", b === btn));
      panels.forEach(p => { p.hidden = p.dataset.tab !== tab; });
      if (save) { DTAB = btn.dataset.name || "overview"; syncUrl(); }
    }
    btns.forEach(btn => btn.addEventListener("click", () => activate(btn, true)));
    if (DTAB !== "overview") {
      const btn = btns.find(b => b.dataset.name === DTAB);
      if (btn) activate(btn, false);
    }
  });
}

// Table ⇄ line-heatmap toggle inside the read_file panel; persists via RFVIEW/the URL.
function wireRfViews(rightEl) {
  rightEl.querySelectorAll(".rf-toggle").forEach(toggle => {
    const wrap = toggle.parentElement;
    const btns = [...toggle.querySelectorAll(".rf-btn")];
    const views = [...wrap.querySelectorAll(":scope > .rf-view")];
    function activate(v, save) {
      if (!btns.some(b => b.dataset.rfview === v)) return;
      btns.forEach(b => b.classList.toggle("active", b.dataset.rfview === v));
      views.forEach(view => { view.hidden = view.dataset.rfview !== v; });
      if (save) { RFVIEW = v; syncUrl(); }
    }
    btns.forEach(btn => btn.addEventListener("click", () => activate(btn.dataset.rfview, true)));
    if (RFVIEW !== "table") activate(RFVIEW, false);
  });
}

// Click a multi-agent file in the heatmap to expand/collapse its per-agent split.
// Each file toggles independently.
function wireHeatExpand(rightEl) {
  rightEl.querySelectorAll(".heat-file.expandable").forEach(row => {
    row.addEventListener("click", () => {
      const split = row.nextElementSibling;
      if (!split || !split.classList.contains("heat-split")) return;
      const collapsed = split.classList.toggle("collapsed");
      row.classList.toggle("expanded", !collapsed);
    });
  });
}

// Click-to-expand rows in the per-tool file/invocation tables (params + result).
function wireFileRows(rightEl) {
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
function wireSortable(table) {
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

// ---------- Modal ----------
let MODAL_SID = null;
// Detail-view toggle state. Global (not per-session) so the same view — e.g. "by tool →
// read_file → heatmap" — greets you in every session you open, and survives via the URL.
let DVIEW = "turns";    // "turns" | "tools" | "files"
let DTAB = "overview";  // by-tool tab: "overview" or a tool name (falls back if absent)
let RFVIEW = "table";   // read_file panel: "table" | "heatmap"

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
  wireDetailViews(right);
  wireToolAgg(right);
  wireToolTabs(right);
  wireRfViews(right);
  wireHeatExpand(right);
  wireFileRows(right);
  right.querySelectorAll("table.tagg-files").forEach(wireSortable);
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
  { name: "Shareable URL", desc: "Every control, the open calendar, the open session, and the detail-view toggles (turns / by tool / by file, tabs, heatmaps) are encoded in the URL — copy it to share the exact view; the toggles also carry over to the next session you open." },
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
const URL_DEFAULTS = { hours: 24, sort: "total_input", limit: "50", min_tokens: "0", view: "charts", combine: "1", unit: "aic",
  dview: "turns", dtab: "overview", rfview: "table" };
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
  // Detail-view toggles persist even with no modal open, so the next session opened
  // (here or from a shared link) lands on the same view.
  if (DVIEW !== URL_DEFAULTS.dview) p.set("dview", DVIEW);
  if (DTAB !== URL_DEFAULTS.dtab) p.set("dtab", DTAB);
  if (RFVIEW !== URL_DEFAULTS.rfview) p.set("rfview", RFVIEW);
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
    // detail-view toggles BEFORE openModal so the restored modal renders with them
    DVIEW = ["turns", "tools", "files"].includes(p.get("dview")) ? p.get("dview") : URL_DEFAULTS.dview;
    DTAB = p.get("dtab") || URL_DEFAULTS.dtab;
    RFVIEW = p.get("rfview") === "heatmap" ? "heatmap" : URL_DEFAULTS.rfview;
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
