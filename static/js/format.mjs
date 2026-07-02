import { S } from "./state.mjs";
import { renderChart } from "./chart.mjs";
import { fmtAicCell } from "./calendar.mjs";

// AI usage viewer frontend.
// Charts are SVG, rendered client-side from session payloads so filtering is responsive.

export const PALETTE = ["#a371f7", "#3fb950", "#ff7b72", "#f0883e", "#79c0ff", "#ffa657", "#d2a8ff", "#56d364"];

export function fmt(n) { return Number(n || 0).toLocaleString(); }

// ---------- Quantity abbreviation ----------
// Big token counts get noisy when shown in full (3,893,592). qty()/qtySvg() collapse
// them to a short value + unit suffix (3.89M, 222k) and tint the suffix so the magnitude
// reads at a glance — k is muted gray, M (the bigger numbers) gets a brighter accent.
export const QTY_UNIT_COLOR = { k: "#768390", M: "#d2a8ff" };
export function qtyParts(n) {
  n = Number(n || 0);
  const a = Math.abs(n);
  if (a >= 1e6) return { num: (n / 1e6).toFixed(2).replace(/\.?0+$/, ""), unit: "M" };
  if (a >= 1e3) return { num: String(Math.round(n / 1e3)), unit: "k" };
  return { num: String(Math.round(n)), unit: "" };
}
// HTML form (uses .q-k / .q-m classes from style.css for the suffix tint).
export function qty(n) {
  const { num, unit } = qtyParts(n);
  return unit ? `${num}<span class="q-${unit}">${unit}</span>` : num;
}
// SVG form — suffix is an inline-filled <tspan> so it works inside chart <text> nodes.
export function qtySvg(n) {
  const { num, unit } = qtyParts(n);
  return unit ? `${num}<tspan fill="${QTY_UNIT_COLOR[unit]}">${unit}</tspan>` : num;
}
// Plain-text form (no markup) for textContent contexts.
export function qtyText(n) { const { num, unit } = qtyParts(n); return num + unit; }

// ---------- Cost unit (global) ----------
// All cost figures are stored as AIC (Copilot credits). The S.UNIT toggle re-expresses
// them as US dollars at the fixed 100 AIC = $1 rate. fmtAic() returns the bare number
// in the active unit; fmtCost() wraps it with the unit ($-prefix for USD, " AIC" suffix
// otherwise); unitLabel() is the standalone symbol for column/section headers.
export function unitLabel() { return S.UNIT === "usd" ? "$" : "AIC"; }
export function aicConvert(n) { return S.UNIT === "usd" ? Number(n || 0) / 100 : Number(n || 0); }
export function fmtAic(n) {
  const v = aicConvert(n);
  const usd = S.UNIT === "usd";
  if (v === 0) return "0";
  if (Math.abs(v) < 1000) return usd ? v.toFixed(2) : v.toFixed(1);  // one decimal, like VS Code's credit badge
  if (Math.abs(v) < 1e6) return (v / 1000).toFixed(usd ? 2 : 1) + "k";
  return (v / 1e6).toFixed(2) + "M";
}
export function fmtCost(n) { return S.UNIT === "usd" ? "$" + fmtAic(n) : fmtAic(n) + " AIC"; }
export function fmtUsd(n) {
  const v = Number(n || 0);
  if (v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return "$" + v.toFixed(4);
  if (Math.abs(v) < 1000) return "$" + v.toFixed(2);
  return "$" + (v / 1000).toFixed(2) + "k";
}
export function hasCostMetric() { return S.SOURCE === "copilot"; }
export function fmtUsdCell(n) {
  const v = Number(n || 0);
  if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "k";
  if (v >= 1) return "$" + Math.round(v);
  if (v >= 0.01) return "$" + v.toFixed(2);
  return "$" + v.toFixed(3);
}
export function metricFmt(n) {
  if (S.CAL_METRIC === "aic") return fmtCost(n);
  if (S.CAL_METRIC === "usd") return fmtUsd(n);
  return `${qtyText(n)} input`;
}
export function metricCell(n) {
  if (S.CAL_METRIC === "aic") return fmtAicCell(n);
  if (S.CAL_METRIC === "usd") return fmtUsdCell(n);
  return qtyText(n);
}
export function calendarButtonLabel() {
  if (S.CAL_METRIC === "aic") return unitLabel();
  if (S.CAL_METRIC === "usd") return "$";
  return "input";
}
export function costColumnLabel() { return hasCostMetric() ? unitLabel() : "cost"; }
export function pad(x) { return String(x).padStart(2, "0"); }
export function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
export function wrapSvgText(text, maxChars, maxLines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (lines.length >= maxLines) break;
    if (word.length <= maxChars) {
      line = word;
    } else {
      lines.push(word.slice(0, maxChars - 1) + "…");
      line = "";
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*.{0,1}$/, "") + "…";
  }
  return lines.length ? lines : ["(no user msg)"];
}
// Render a tool arg/result blob: JSON objects become a dense 2-column key/value
// table; everything else renders as a verbatim text chunk.
export function renderValue(str) {
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
export function summarizeArgs(str) {
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
export function oneLine(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 110 ? s.slice(0, 109) + "…" : s;
}
export function niceCeil(n) {
  if (n <= 0) return 1000;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  for (const f of [1, 1.5, 2, 2.5, 5, 10]) if (mag * f >= n) return mag * f;
  return n;
}
export function dotFill(c) {
  const cp = c.input > 0 ? c.cached / c.input : 0;
  return cp > 0.7 ? "#58a6ff" : (cp > 0.3 ? "#d29922" : "#f85149");
}
// User-message turns are the human's own input — the moments a person actually
// typed something — so they get a distinct gold star drawn ON TOP of every other
// marker (see the star pass at the end of renderChart's marker drawing).
export const USER_MSG_COLOR = "#ffd33d";
export function starPoints(cx, cy, R) {
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
export const REASONING_COLORS = { minimal: "#6e7681", low: "#3fb950", medium: "#d29922", high: "#ff9a3c", xhigh: "#f85149" };
export function reasoningBadge(r) {
  if (!r) return `<span class="rsn-none">—</span>`;
  // mixed levels ("medium·xhigh") render each as its own chip
  return String(r).split("·").map(part => {
    const col = REASONING_COLORS[part] || "#a371f7"; // think:* / unknown → purple
    return `<span class="rsn" style="--rc:${col}">${escapeHtml(part)}</span>`;
  }).join(" ");
}

export function sourceLabelHtml(s) {
  if (S.SOURCE !== "all" || !s.source_label) return "";
  return `<span class="source-pill ${escapeHtml(s.source || "")}">${escapeHtml(s.source_label)}</span>`;
}

export function localMaxT(payload) {
  let mx = 1000;
  for (const c of payload.main || []) if (c.t > mx) mx = c.t;
  for (const k of payload.kids || []) for (const c of k.calls) if (c.t > mx) mx = c.t;
  return Math.max(60000, Math.ceil(mx / 30000) * 30000);
}
