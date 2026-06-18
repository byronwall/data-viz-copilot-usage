import { S } from "./state.mjs";
import { niceCeil } from "./format.mjs";
import { renderChart } from "./chart.mjs";
import { renderDetail } from "./detail.mjs";
import { wireDetailFilter, wireDetailViews, wireExpand, wireFileRows, wireHeatExpand, wireRfViews, wireSelect, wireSortable, wireToolAgg, wireToolTabs } from "./chart-select.mjs";
import { closeHelp } from "./help.mjs";
import { syncUrl } from "./url-state.mjs";
import { closeCal } from "./calendar.mjs";

// ---------- Modal ----------
// Detail-view toggle state. Global (not per-session) so the same view — e.g. "by tool →
// read_file → heatmap" — greets you in every session you open, and survives via the URL.

export async function openModal(sid, maxTok) {
  const modal = document.getElementById("modal");
  const chartHolder = document.getElementById("modalChart");
  const right = document.getElementById("modalRight");
  chartHolder.innerHTML = `<div class="muted" style="padding:20px">loading…</div>`;
  right.innerHTML = "";
  modal.classList.add("open");
  S.MODAL_SID = sid;
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
  wireDetailFilter(right);
  right.querySelectorAll("table.tagg-files").forEach(wireSortable);
  stickCallsHeader(right);
}

// The per-turn table's column header sticks below the (also-sticky) modal-header.
// Its height is dynamic (prompt length, wrapped totals), so measure it and expose
// the offset as a CSS var the th's `top` reads.
export function stickCallsHeader(scrollEl) {
  const hdr = scrollEl.querySelector(".modal-header");
  if (hdr) scrollEl.style.setProperty("--calls-th-top", hdr.offsetHeight + "px");
}

export function closeModal() {
  document.getElementById("modal").classList.remove("open");
  if (S.MODAL_SID) { S.MODAL_SID = null; syncUrl(true); }
}
document.getElementById("closeBtn").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); closeCal(); closeHelp(); } });

