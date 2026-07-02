"""Shared constants for the analyzer package.

These are immutable lookup tables / name sets used across the source backends.
Mutable, test-patchable configuration (the on-disk base paths) lives in the
package's ``__init__`` instead, so tests can rebind ``analyzer.<NAME>``.
"""
from __future__ import annotations

COMPACT_NAMES = {
    "summarizeConversationHistory",
    "summarizeConversationHistory-simple",
    "summarizeVirtualTools",
    "context_compacted",
    "compacted",
}
SOURCES = {"all", "copilot", "codex", "claude"}
# Requests VS Code sends with interactionTypeOverride:"conversation-background" — the
# extension excludes their copilot usage from the per-turn credit badge, so we must too
# (see setLastCopilotUsage gating in the copilot-chat bundle).
BACKGROUND_NAMES = {
    "git-branch",
    "backgroundTodoAgent",
    "summarize",
    "title",
    "promptCategorization",
    "contextualProgressMessage",
    "progressMessages",
}
FIND_PREFIX = "Find relevant code snippets for:"

# Display order for reasoning levels (low → highest); anything unknown sorts last-but-known.
_REASONING_RANK = {"minimal": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4}
