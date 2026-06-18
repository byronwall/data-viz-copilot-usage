// Entry point: evaluate every section module (for their top-level event wiring),
// then bootstrap from the URL once the whole graph is initialized.
import "./format.mjs";
import "./chart.mjs";
import "./detail.mjs";
import "./tool-agg.mjs";
import "./file-agg.mjs";
import "./chart-select.mjs";
import "./modal.mjs";
import "./help.mjs";
import "./range.mjs";
import "./url-state.mjs";
import "./calendar.mjs";
import "./main.mjs";
import { applyUrlState } from "./url-state.mjs";

applyUrlState();
