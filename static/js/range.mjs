import { S } from "./state.mjs";
import { loadSessions } from "./main.mjs";

// ---------- Date range controls ----------
export const startEl = document.getElementById("start_date");
export const endEl = document.getElementById("end_date");
export const rangeInfoEl = document.getElementById("rangeInfo");

// True while the window means "the last N hours up to now" (initial load and the
// quick buttons). Refresh then re-anchors the window to now so sessions written
// since the last load are included. Manually edited dates, calendar day picks,
// and ◀/▶ stepping express a fixed historical window, which unpins.

// datetime-local needs "YYYY-MM-DDTHH:mm" in LOCAL time (no TZ suffix)
export function tsToLocalInput(ts) {
  const d = new Date(ts * 1000);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
export function localInputToTs(v) {
  if (!v) return null;
  return Math.floor(new Date(v).getTime() / 1000);
}
export function getRangeTs() {
  return [localInputToTs(startEl.value), localInputToTs(endEl.value)];
}
export function setRangeTs(startTs, endTs) {
  startEl.value = tsToLocalInput(startTs);
  endEl.value = tsToLocalInput(endTs);
  updateRangeInfo();
  updateQuickActive();
}
export function updateRangeInfo() {
  const [s, e] = getRangeTs();
  if (!s || !e) { rangeInfoEl.textContent = ""; return; }
  const hrs = (e - s) / 3600;
  let label;
  if (hrs < 1) label = `${Math.round((e - s) / 60)}m`;
  else if (hrs < 48) label = `${hrs.toFixed(hrs < 6 ? 1 : 0)}h`;
  else label = `${(hrs / 24).toFixed(1)}d`;
  rangeInfoEl.textContent = `(${label} window)`;
}
export function updateQuickActive() {
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
export function shiftRange(direction) {
  const [s, e] = getRangeTs();
  if (!s || !e) return;
  const span = e - s;
  setRangeTs(s + direction * span, e + direction * span);
}

document.querySelectorAll("button.quick").forEach(b => {
  b.addEventListener("click", () => {
    const h = Number(b.dataset.hours);
    const now = Math.floor(Date.now() / 1000);
    S.RANGE_PINNED = true;
    setRangeTs(now - h * 3600, now);
    loadSessions();
  });
});
document.getElementById("prevBtn").addEventListener("click", () => { S.RANGE_PINNED = false; shiftRange(-1); loadSessions(); });
document.getElementById("nextBtn").addEventListener("click", () => { S.RANGE_PINNED = false; shiftRange(+1); loadSessions(); });
startEl.addEventListener("change", () => { S.RANGE_PINNED = false; updateRangeInfo(); updateQuickActive(); loadSessions(); });
endEl.addEventListener("change", () => { S.RANGE_PINNED = false; updateRangeInfo(); updateQuickActive(); loadSessions(); });

