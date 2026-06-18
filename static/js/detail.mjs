import { S } from "./state.mjs";
import { costColumnLabel, escapeHtml, fmt, fmtAic, hms, oneLine, qty, reasoningBadge, renderValue, summarizeArgs, unitLabel } from "./format.mjs";
import { renderToolAgg } from "./tool-agg.mjs";
import { renderFileAgg } from "./file-agg.mjs";

// ---------- Tool-call failure detection ----------
// A tool's logged status (t.s) is almost always "ok" even when the operation failed, so
// failures are detected from well-known result-text markers instead. Returns a short
// human-readable reason when a call looks failed, or "" when it looks successful. The
// markers below were derived from a sweep of real session logs — they cover apply_patch,
// read_file, create_file, run_in_terminal, runSubagent/search_subagent and MCP tools, and
// are anchored to the START of the result so file contents / test summaries that merely
// mention "error" don't get flagged.
export function firstLine(s) { return oneLine(String(s ?? "").split("\n")[0]); }
export function toolFailReason(t) {
  if (!t) return "";
  const st = String(t.s ?? "").toLowerCase();
  const okStatuses = new Set(["ok", "success", "completed", "complete", "?"]);
  const statusBad = st && !okStatuses.has(st);
  const s = String(t.res ?? "").replace(/^\s+/, "");
  if (!s) return statusBad ? st : "";
  const sl = s.toLowerCase();
  // apply_patch self-correction recovered and applied — that's a SUCCESS, not a failure.
  if (sl.startsWith("there was an error applying your original patch")) return "";
  if (sl.startsWith("applying patch failed with error")) return firstLine(s);
  if (sl.startsWith("agent error:")) return firstLine(s);
  if (sl.startsWith("error:")) return firstLine(s);                 // VS Code generic tool error (read_file, create_file, runSubagent, "ERROR: Canceled", terminal command errors)
  if (sl.startsWith("failed to retrieve command output")) return "failed to retrieve command output";
  if (s.startsWith("### Error")) {                                  // MCP tools render "### Error\n<message>"
    const msg = s.split("\n").map(x => x.trim()).filter(Boolean)[1];
    return oneLine(msg || "error");
  }
  return statusBad ? st : "";
}
export function toolFailed(t) { return !!toolFailReason(t); }

// One tool call's collapsible block: a one-line head (name + arg gist + duration +
// copy) that expands to the full args (and result, if any). Shared by the per-turn
// table and the by-tool aggregate view so both render tool params identically.
// Failed calls get an orange ⚠ at the far left, an orange-tinted block, and the failure
// reason in place of the arg gist so the cause reads without expanding.
export function toolBlockHtml(t) {
  const dur = t.d > 0 ? `<span class="dur">${t.d}ms</span>` : "";
  const fail = toolFailReason(t);
  const summary = fail || summarizeArgs(t.a || "");
  let detail = renderValue(t.a || "");
  if (t.res) detail += `<div class="res"><span class="reslbl">result</span><div class="res-body clamped">${renderValue(t.res)}</div><button class="res-toggle" type="button">show more</button></div>`;
  const copyAttr = encodeURIComponent(String(t.a ?? "") + (t.res ? `\n\n--- result ---\n${t.res}` : ""));
  const failIcon = fail ? `<span class="fail-icon" title="tool call failed: ${escapeHtml(fail)}">⚠</span>` : "";
  return `<div class="tool${fail ? " tool-failed" : ""}"><div class="tool-head">${failIcon}<span class="caret">▸</span><span class="nm">${escapeHtml(t.n)}</span><button class="copy-btn" type="button" data-copy="${copyAttr}" title="Copy full message to clipboard">copy</button>${dur}<span class="summary">${escapeHtml(summary)}</span></div><div class="tool-detail collapsed">${detail}</div></div>`;
}

export function renderDetail(payload) {
  const all = [];
  (payload.main || []).forEach(c => all.push({ ...c, _grp: "P" }));
  (payload.kids || []).forEach((k, ki) => k.calls.forEach(c => all.push({ ...c, _grp: "K" + ki, _label: k.label })));
  const total_in = payload.total_input, total_cached = payload.total_cached, total_out = payload.total_output;
  const total_uncached = total_in - total_cached;
  const compactCalls = all.filter(c => c.compact);
  const compact_total = compactCalls.reduce((s, c) => s + c.input, 0);
  const total_aic = payload.total_aic != null ? payload.total_aic : all.reduce((s, c) => s + (c.aic || 0), 0);
  let nToolCalls = 0, nToolFails = 0;
  all.forEach(c => (c.tools || []).forEach(t => { if (t.n !== "user_message") { nToolCalls++; if (toolFailed(t)) nToolFails++; } }));

  // No chips — search-children are rendered inline as sub-agent sections in the table.
  // For orphan find-sessions (those visible standalone because no parent was matched), show a
  // single inert note so the user knows it came from a wider context. Otherwise nothing here.
  let linkChip = "";
  if (payload.parent_sid && payload.parent_first_user) {
    linkChip = `<div class="chip muted-chip">spawned by: ${escapeHtml(payload.parent_first_user.slice(0, 100))}</div>`;
  }

  let html = `
  <div class="modal-header">
    <div class="modal-meta">${escapeHtml(payload.sid)} · ${escapeHtml(payload.source_label || "")} · ws ${escapeHtml(payload.workspace || "")} · ${new Date(payload.last_event_ts || payload.mtime * 1000).toLocaleString()} · model ${escapeHtml(payload.top_model)}${payload.reasoning ? ` · reasoning ${reasoningBadge(payload.reasoning)}` : ""}</div>
    <div class="modal-prompt">${escapeHtml(payload.first_user || "(no user message)")}</div>
    ${linkChip}
    <div class="modal-totals">
      <span>input <b>${qty(total_in)}</b></span>
      <span>cached <b style="color:#58a6ff">${qty(total_cached)}</b> (${total_in ? Math.round(100 * total_cached / total_in) : 0}%)</span>
      <span>uncached <b style="color:#f85149">${qty(total_uncached)}</b></span>
      <span>output <b>${qty(total_out)}</b></span>
      ${payload.cost_available ? `<span>${unitLabel()} <b style="color:#56d364">${fmtAic(total_aic)}</b></span>` : `<span>cost <b style="color:#444">—</b></span>`}
      <span>turns <b>${all.length}</b></span>
      <span>compactions <b style="color:#ff9a3c">${compactCalls.length}</b> (${fmt(compact_total)} tok)</span>
      <span>tool fails <b style="color:${nToolFails ? "#ff9a3c" : "#444"}">${nToolFails}</b>${nToolCalls ? ` / ${fmt(nToolCalls)} (${Math.round(100 * nToolFails / nToolCalls)}%)` : ""}</span>
      <span>duration <b>${hms(payload.duration_ms)}</b></span>
    </div>
    <div class="dview-controls">
      <div class="view-toggle dview-toggle">
        <button type="button" class="dview-btn active" data-dview="turns">turns</button>
        <button type="button" class="dview-btn" data-dview="tools">by tool</button>
        <button type="button" class="dview-btn" data-dview="files">by file</button>
      </div>
      <span class="dfilter-wrap"><input type="search" id="dviewFilter" class="dfilter" placeholder="filter file path… e.g. /docs" value="${escapeHtml(S.DFILTER)}" spellcheck="false" autocomplete="off"><span class="dfilter-count" id="dfilterCount"></span></span>
    </div>
  </div>
  <div class="dview" data-dview="turns">
  <table class="calls">
    <thead><tr>
      <th>#</th><th>t</th><th>debugName</th><th>rsn</th>
      <th class="num">input</th><th class="num">cached</th><th class="num">uncached</th>
      <th class="num">out</th><th class="num">${costColumnLabel()}</th><th>tool calls</th>
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
    const nFail = tools.filter(toolFailed).length;
    const failBadge = nFail ? ` <span class="toolfail-badge" title="${nFail} failed tool call${nFail > 1 ? "s" : ""}">⚠ ${nFail}</span>` : "";
    const toolSummary = tools.length === 0
      ? `<span style="color:#444">—</span>`
      : tools.slice(0, 3).map(t => {
          const f = toolFailed(t);
          return `<span style="color:${f ? "#ff9a3c" : "#79c0ff"}"${f ? ` title="failed"` : ""}>${f ? "⚠" : ""}${escapeHtml(t.n)}</span>`;
        }).join(" ")
        + (tools.length > 3 ? ` <span style="color:#666">+${tools.length - 3}</span>` : "")
        + failBadge;
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

