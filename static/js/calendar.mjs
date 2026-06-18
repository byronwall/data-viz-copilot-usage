import { S } from "./state.mjs";
import { aicConvert, calendarButtonLabel, metricCell, metricFmt, pad } from "./format.mjs";
import { setRangeTs } from "./range.mjs";
import { syncUrl } from "./url-state.mjs";
import { loadSessions } from "./main.mjs";

// ---------- Daily usage calendar ----------
// Year heatmap of selected daily metric, fed by /api/daily_usage.
// Wide: one row per month (31 day columns). Narrow: classic 7-day week grids per month.
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function calKey(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

// Cells always use N.nk so small days don't render with more digits than big ones.
export function fmtAicCell(v) {
  const x = aicConvert(v);
  if (S.UNIT === "usd") return "$" + (x >= 1000 ? (x / 1000).toFixed(1) + "k" : Math.round(x));
  return (x / 1000).toFixed(1) + "k";
}

// GitHub-contribution-style green ramp; intensity ∝ sqrt(v/max) so mid days stay visible.
export function calHeat(v, max) {
  if (!v || max <= 0) return { bg: "var(--row)", fg: "#8b949e" };
  const t = Math.sqrt(Math.min(1, v / max));
  const ramp = ["#0e4429", "#006d32", "#26a641", "#39d353"];
  const i = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
  return { bg: ramp[i], fg: i >= 2 ? "#04260f" : "#e6f4ea" };
}

export function calCell(y, m, d, max, today) {
  const key = calKey(y, m, d);
  const v = S.CAL_DAYS[key] || 0;
  const { bg, fg } = calHeat(v, max);
  const cls = ["cal-cell"];
  if (key === today) cls.push("today");
  if (key === S.CAL_SELECTED) cls.push("selected");
  // zero-usage days are inert: no data-date (click delegation skips), no hover affordance
  if (!v) {
    return `<div class="${cls.join(" ")}" style="background:${bg}"><span class="d">${d}</span></div>`;
  }
  const title = `${MONTH_NAMES[m]} ${d}, ${y} · ${metricFmt(v)}`;
  return `<div class="${cls.join(" ")}" data-date="${key}" title="${title}" style="background:${bg}">` +
    `<span class="d">${d}</span>` +
    `<span class="v" style="color:${fg}">${metricCell(v)}</span>` +
    `</div>`;
}

export function renderCalendar() {
  const el = document.getElementById("calendar");
  const y = S.CAL_YEAR;
  const today = calKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  let max = 0, yearTotal = 0;
  for (const [k, v] of Object.entries(S.CAL_DAYS)) {
    if (!k.startsWith(`${y}-`)) continue;
    yearTotal += v;
    if (v > max) max = v;
  }
  document.getElementById("calYear").textContent = String(y);
  document.getElementById("calInfo").textContent = yearTotal ? `· ${metricFmt(yearTotal)} this year` : `· no ${S.CAL_UNIT} this year`;

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

export async function loadCalendar() {
  try {
    const resp = await fetch(`/api/daily_usage?source=${encodeURIComponent(S.SOURCE)}`);
    const data = await resp.json();
    S.CAL_DAYS = data.days || {};
    S.CAL_COST = data.cost !== false;
    S.CAL_UNIT = data.unit || (S.CAL_COST ? "AIC" : "input tokens");
    calTrigger.textContent = `📅 ${calendarButtonLabel()}`;
    // default to the most recent year that has data (usually current year)
    const years = Object.keys(S.CAL_DAYS).map(k => Number(k.slice(0, 4)));
    if (years.length && !years.includes(S.CAL_YEAR)) S.CAL_YEAR = Math.max(...years);
    renderCalendar();
  } catch (e) {
    document.getElementById("calendar").innerHTML = `<div class="muted" style="padding:8px">failed to load daily usage</div>`;
  }
}

// Popover plumbing — the calendar acts as an advanced date picker off the controls bar.
export const calPop = document.getElementById("calPop");
export const calTrigger = document.getElementById("calTrigger");

export function openCal() {
  calPop.hidden = false;
  calTrigger.classList.add("active");
  if (!S._calLoaded) { S._calLoaded = true; loadCalendar(); }
  else renderCalendar(); // re-measure width / refresh selection
  syncUrl();
}
export function closeCal() {
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
  S.CAL_SELECTED = key;
  closeCal();
  S.RANGE_PINNED = false;
  setRangeTs(start, start + 86400);
  loadSessions();
});
document.getElementById("calPrevYear").addEventListener("click", () => { S.CAL_YEAR--; renderCalendar(); syncUrl(); });
document.getElementById("calNextYear").addEventListener("click", () => { S.CAL_YEAR++; renderCalendar(); syncUrl(); });

export let _calResizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(_calResizeT);
  _calResizeT = setTimeout(() => { if (!calPop.hidden) renderCalendar(); }, 150);
});

