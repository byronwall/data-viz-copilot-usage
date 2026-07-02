"""Cost (AIC) computation for every backend.

Copilot has exact billing on disk (per-request nanoAiu, or token prices from
models.json, or a legacy premium-request multiplier). Claude has no local cost, so we
estimate it from published per-tier Anthropic token pricing. ``_req_cost_aic`` is the
source-aware dispatch used by the summary/detail builders.
"""
from __future__ import annotations
import os, json, glob, time
from typing import Optional, TYPE_CHECKING

from llmly import analyzer
from .constants import BACKGROUND_NAMES

if TYPE_CHECKING:
    from .models import Session

# ---------- Caches ----------

_MODELS_CACHE: dict[str, tuple[float, dict]] = {}  # session_dir -> (mtime, {model_id: billing-info dict})
_GLOBAL_PRICES: dict[str, dict] | None = None  # union across all models.json with non-null billing
_GLOBAL_PRICES_BUILT_AT: float = 0.0


# ---------- Copilot billing (models.json) ----------

def _parse_billing(m: dict) -> dict | None:
    """Normalize one models.json entry's billing block.

    Two schemas exist on disk:
      old: {"multiplier": 1, "is_premium": true}              (premium-request counting)
      new: {"token_prices": {"batch_size": 1e6, "default":    (credit pricing per token)
            {"input_price": 250, "cache_price": 25, "output_price": 1500}}}
    Returns {"prices": {...}} and/or {"mult": float, "premium": bool}, or None if unpopulated.
    """
    b = m.get("billing") or {}
    info: dict = {}
    tp = b.get("token_prices") or {}
    d = tp.get("default") or {}
    if d:
        info["prices"] = {
            "input": float(d.get("input_price", 0) or 0),
            "cache": float(d.get("cache_price", 0) or 0),
            "output": float(d.get("output_price", 0) or 0),
            "batch": float(tp.get("batch_size", 1_000_000) or 1_000_000),
        }
    mult = b.get("multiplier")
    premium = b.get("is_premium")
    if mult is not None or premium is not None:
        mult_f = float(mult or 0)
        info["mult"] = mult_f
        info["premium"] = bool(premium) if premium is not None else mult_f > 0
    return info or None


def _build_global_prices() -> dict[str, dict]:
    """Scan every models.json on disk; keep the best (populated) billing entry per model id."""
    global _GLOBAL_PRICES, _GLOBAL_PRICES_BUILT_AT
    # rebuild at most once every 10 minutes
    if _GLOBAL_PRICES is not None and (time.time() - _GLOBAL_PRICES_BUILT_AT) < 600:
        return _GLOBAL_PRICES
    table: dict[str, dict] = {}
    for fp in glob.glob(f"{analyzer.BASE}/*/GitHub.copilot-chat/debug-logs/*/models.json"):
        try:
            with open(fp) as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for m in data:
            mid = m.get("id")
            if not mid:
                continue
            info = _parse_billing(m)
            if not info:
                continue
            cur = table.get(mid)
            # prefer token-price entries (newer schema); among multiplier-only entries, the largest
            if not cur or ("prices" in info and "prices" not in cur) or \
               ("prices" not in cur and info.get("mult", 0) > cur.get("mult", 0)):
                table[mid] = info
    _GLOBAL_PRICES = table
    _GLOBAL_PRICES_BUILT_AT = time.time()
    return table


def _load_models_json(session_dir: str) -> dict:
    """Return {model_id: (multiplier, is_premium)} for one session dir."""
    path = os.path.join(session_dir, "models.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    cached = _MODELS_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    info: dict[str, dict] = {}
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, list):
            for m in data:
                mid = m.get("id")
                if not mid:
                    continue
                bi = _parse_billing(m)
                if bi:
                    info[mid] = bi
    except Exception:
        pass
    _MODELS_CACHE[path] = (mtime, info)
    return info


def _aic_for_req(r: dict, models_info: dict) -> float:
    """Credits (AIC) for one llm_request, matching VS Code's per-turn credit badge.

    Priority:
      1. attrs.copilotUsageNanoAiu — the billed value the Copilot API reports per request.
         This is what VS Code itself sums (÷1e9) for the "N credits" badge, so it's exact.
      2. token_prices from models.json: (input-cached)*input + cached*cache + output*output,
         per batch_size tokens (verified to reproduce nanoAiu to the digit).
      3. Legacy premium-request multiplier (older logs, pre credit-billing).

    Background requests (title generator, todo agent, …) are excluded — VS Code skips
    interactionTypeOverride:"conversation-background" requests when accumulating turn credits.
    """
    if r.get("debugName") in BACKGROUND_NAMES:
        return 0.0
    nano = r.get("nano_aiu")
    if nano is not None:
        return nano / 1e9
    model_id = r.get("model")
    info = models_info.get(model_id)
    if not info or ("prices" not in info and not info.get("premium")):
        # session-local entry missing/unpopulated (recent gpt-5.x often have null billing
        # locally) — fall back to the global table built from every models.json on disk
        info = _build_global_prices().get(model_id) or info or {}
    p = info.get("prices")
    if p:
        inp = r.get("input", 0) or 0
        cached = r.get("cached", 0) or 0
        out = r.get("output", 0) or 0
        return (max(0, inp - cached) * p["input"] + cached * p["cache"] + out * p["output"]) / p["batch"]
    return info.get("mult", 0.0) if info.get("premium") else 0.0


# ---------- Claude pricing (estimated from published per-tier token prices) ----------

# Anthropic standard-tier pricing, USD per 1,000,000 tokens (retrieved 2026-06-18).
# Priced per TIER (family), not per minor version — matched by substring in the model id.
_CLAUDE_TIER_PRICES_USD = {
    # tier:   (input, output, cache_write_5m, cache_read)
    "opus":   (5.00, 25.00, 6.25, 0.50),
    "sonnet": (3.00, 15.00, 3.75, 0.30),
    "haiku":  (1.00, 5.00, 1.25, 0.10),
    "fable":  (10.00, 50.00, 12.50, 1.00),
}
# Legacy ids matched BEFORE family matching (exact-id substring).
_CLAUDE_LEGACY_PRICES_USD = {
    "claude-opus-4-1": (15.00, 75.00, 18.75, 1.50),
    "claude-haiku-3-5": (0.80, 4.00, 1.00, 0.08),
}


def _claude_price(model_id: str | None) -> Optional[dict]:
    """AIC-per-token price dict for a Claude model id, or None if no tier matches.

    AIC = USD * 100, and these tables are USD per 1,000,000 tokens, so the
    per-token AIC factor is usd_per_million / 1_000_000 * 100.
    A <synthetic> id (or any id with no tier match) returns None -> 0 cost.
    """
    if not model_id:
        return None
    mid = model_id.lower()
    usd = None
    for legacy_id, prices in _CLAUDE_LEGACY_PRICES_USD.items():
        if legacy_id in mid:
            usd = prices
            break
    if usd is None:
        for tier, prices in _CLAUDE_TIER_PRICES_USD.items():
            if tier in mid:
                usd = prices
                break
    if usd is None:
        return None
    inp, out, cw, cr = usd
    f = 1.0 / 1_000_000 * 100  # USD/Mtok -> AIC/token
    return {"input": inp * f, "output": out * f, "cache_write": cw * f, "cache_read": cr * f}


def _claude_req_aic(r: dict) -> float:
    """Estimated AIC cost for a single Claude req event."""
    p = _claude_price(r.get("model"))
    if p is None:
        return 0.0
    cached = r.get("cached", 0) or 0
    cache_creation = r.get("cache_creation", 0) or 0
    fresh = max(0, (r.get("input", 0) or 0) - cached - cache_creation)
    out = r.get("output", 0) or 0
    cost = (fresh * p["input"] + cached * p["cache_read"]
            + cache_creation * p["cache_write"] + out * p["output"])
    return cost if cost > 0 else 0.0


def _req_cost_aic(sess: "Session", c: dict) -> Optional[float]:
    """Source-aware per-call AIC dispatch."""
    if not sess.cost_available:
        return None
    if sess.source == "claude":
        return _claude_req_aic(c)
    return _aic_for_req(c, sess.models_info)
