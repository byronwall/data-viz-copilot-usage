// Shared mutable UI state.
// In ES modules an imported binding can't be reassigned by the importer, so the
// state that multiple sections write lives here as one object and is mutated in place.
export const S = {
  UNIT: "aic",
  SOURCE: "all",
  CAL_COST: false,
  CAL_UNIT: "input tokens",
  MODAL_SID: null,
  DVIEW: "turns",
  DTAB: "overview",
  RFVIEW: "table",
  DFILTER: "",
  HELP_OPEN: false,
  RANGE_PINNED: true,
  CAL_DAYS: {},
  CAL_YEAR: new Date().getFullYear(),
  CAL_SELECTED: null,
  _calLoaded: false,
  VIEW: "charts",
  COMBINE: true,
};
