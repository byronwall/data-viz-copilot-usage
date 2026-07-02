import { PALETTE, USER_MSG_COLOR, dotFill, escapeHtml, fmtCost, hms, localMaxT, niceCeil, qtySvg, starPoints, wrapSvgText } from "./format.mjs";

export function renderChart(payload, opts) {
  const { w = 360, h = 398, maxTok, big = false, interactive = false } = opts || {};
  const localMax = localMaxT(payload);
  // Layout: top header (mt) → main chart (ih_main) → time labels (timeAxisH) →
  //         sub chart (ih_sub) → footer (mb)
  const ml = big ? 70 : 56, mr = 16;
  const mt = big ? 50 : 44;
  const mb = big ? 58 : 54;
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
  // Row 2: output + cache% + available cost (the rest of the totals) followed by turn structure
  // (reqs, subs, compactions, linkage chips). Overflow from row 1 lands here so it all fits.
  let row2parts = [];
  // Always show the source/model label — even when a global filter is active — so the
  // chart is self-describing and you don't have to remember/check which source is selected.
  if (payload.source_label) {
    row2parts.push(`<tspan fill="${payload.source === "codex" ? "#56d364" : payload.source === "claude" ? "#d2a8ff" : "#79c0ff"}">${escapeHtml(payload.source_label)}</tspan>`);
  }
  row2parts.push(`<tspan fill="#c9d1d9">${qtySvg(payload.total_output)}</tspan> out`);
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

  // Footer: first user message, wrapped so long goals remain recognizable in cards.
  const footerFs = big ? 11 : 9;
  const footerLineH = big ? 13 : 11;
  const footerMaxChars = Math.max(16, Math.floor((w - 12) / (footerFs * 0.6)));
  const titleLines = wrapSvgText(payload.first_user || "(no user msg)", footerMaxChars, 3);
  svg += `<text x="6" y="${h - mb + 18}" fill="#7d8590" font-size="${footerFs}">`;
  titleLines.forEach((line, i) => {
    svg += `<tspan x="6" dy="${i === 0 ? 0 : footerLineH}">${escapeHtml(line)}</tspan>`;
  });
  svg += `</text>`;
  svg += "</svg>";
  return svg;
}

