import { S } from "./state.mjs";
import { closeModal, openModal } from "./modal.mjs";
import { closeHelp, openHelp } from "./help.mjs";
import { getRangeTs, setRangeTs } from "./range.mjs";
import { calPop, closeCal, openCal } from "./calendar.mjs";
import { applySourceControls, loadSessions } from "./main.mjs";

// ---------- URL state ----------
// Every control + open overlays serialize into query params so a refresh (or a
// shared link) restores the exact view. Pinned "last N hours" windows persist as
// hours=N (re-anchored to now on load); explicit windows persist as start/end
// unix timestamps. Params at their defaults are omitted to keep URLs clean.
export const URL_DEFAULTS = { hours: 24, sort: "total_input", limit: "50", min_tokens: "0", source: "all", view: "charts", combine: "1", unit: "aic",
  dview: "turns", dtab: "overview", rfview: "table" };
export let SUPPRESS_URL = false; // true while restoring state FROM the URL

export function syncUrl(push = false) {
  if (SUPPRESS_URL) return;
  const p = new URLSearchParams();
  const [s, e] = getRangeTs();
  if (S.RANGE_PINNED && s && e) {
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
  if (S.SOURCE !== URL_DEFAULTS.source) p.set("source", S.SOURCE);
  if (S.VIEW !== URL_DEFAULTS.view) p.set("view", S.VIEW);
  if (!S.COMBINE) p.set("combine", "0");
  if (S.UNIT !== URL_DEFAULTS.unit) p.set("unit", S.UNIT);
  if (S.CAL_SELECTED) p.set("day", S.CAL_SELECTED);
  if (!calPop.hidden) { p.set("cal", "1"); p.set("cal_year", String(S.CAL_YEAR)); }
  if (S.MODAL_SID) p.set("session", S.MODAL_SID);
  // Detail-view toggles persist even with no modal open, so the next session opened
  // (here or from a shared link) lands on the same view.
  if (S.DVIEW !== URL_DEFAULTS.dview) p.set("dview", S.DVIEW);
  if (S.DTAB !== URL_DEFAULTS.dtab) p.set("dtab", S.DTAB);
  if (S.RFVIEW !== URL_DEFAULTS.rfview) p.set("rfview", S.RFVIEW);
  if (S.DFILTER) p.set("dfilter", S.DFILTER);
  if (S.HELP_OPEN) p.set("help", "1");
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

export function applyUrlState() {
  const p = new URLSearchParams(location.search);
  SUPPRESS_URL = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = Number(p.get("start")), end = Number(p.get("end"));
    if (start && end && end > start) {
      S.RANGE_PINNED = false;
      setRangeTs(start, end);
    } else {
      const hours = Number(p.get("hours")) || URL_DEFAULTS.hours;
      S.RANGE_PINNED = true;
      setRangeTs(now - hours * 3600, now); // bumpless: pinned windows re-anchor to now
    }
    document.getElementById("sort").value = p.get("sort") || URL_DEFAULTS.sort;
    document.getElementById("limit").value = p.get("limit") || URL_DEFAULTS.limit;
    document.getElementById("min_tokens").value = p.get("min_tokens") || URL_DEFAULTS.min_tokens;
    S.SOURCE = ["all", "copilot", "codex", "claude"].includes(p.get("source")) ? p.get("source") : URL_DEFAULTS.source;
    applySourceControls();
    S.VIEW = p.get("view") === "table" ? "table" : "charts";
    S.COMBINE = p.get("combine") !== "0";
    S.UNIT = p.get("unit") === "usd" ? "usd" : "aic";
    S.CAL_SELECTED = p.get("day") || null;
    const calYear = Number(p.get("cal_year"));
    if (calYear) S.CAL_YEAR = calYear;
    if (p.get("cal") === "1") openCal(); else closeCal();
    // detail-view toggles BEFORE openModal so the restored modal renders with them
    S.DVIEW = ["turns", "tools", "files"].includes(p.get("dview")) ? p.get("dview") : URL_DEFAULTS.dview;
    S.DTAB = p.get("dtab") || URL_DEFAULTS.dtab;
    S.RFVIEW = p.get("rfview") === "heatmap" ? "heatmap" : URL_DEFAULTS.rfview;
    S.DFILTER = p.get("dfilter") || "";
    const sid = p.get("session");
    if (sid && sid !== S.MODAL_SID) openModal(sid);
    else if (!sid && S.MODAL_SID) closeModal();
    if (p.get("help") === "1") openHelp(); else closeHelp();
  } finally {
    SUPPRESS_URL = false;
  }
  loadSessions();
}

window.addEventListener("popstate", applyUrlState);

