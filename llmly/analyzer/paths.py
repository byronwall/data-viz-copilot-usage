"""Platform-specific discovery of the on-disk locations each source backend reads.

These are pure functions with no package state; the package ``__init__`` calls them
once to seed the module-level base-path constants (which tests may then rebind).
"""
from __future__ import annotations
import os, sys


def _default_workspace_storage() -> str:
    """Locate VS Code's workspaceStorage dir for the current platform.

    Override with the COPILOT_USAGE_STORAGE env var if your install is non-standard
    (e.g. VS Code Insiders or VSCodium — point it at the equivalent workspaceStorage dir).
    """
    env = os.environ.get("COPILOT_USAGE_STORAGE")
    if env:
        return os.path.expanduser(env)
    if sys.platform == "darwin":
        root = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        root = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
    else:  # linux / other unix
        root = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(root, "Code", "User", "workspaceStorage")


def _default_codex_home() -> str:
    """Locate Codex's local state directory.

    CODEX_USAGE_HOME is viewer-specific; CODEX_HOME matches Codex itself.
    """
    env = os.environ.get("CODEX_USAGE_HOME") or os.environ.get("CODEX_HOME")
    return os.path.expanduser(env) if env else os.path.expanduser("~/.codex")


def _default_claude_home() -> str:
    """Locate Claude's local state directory (Claude Code CLI and Claude Desktop).

    CLAUDE_USAGE_HOME is viewer-specific; CLAUDE_CONFIG_DIR matches Claude Code itself.
    """
    env = os.environ.get("CLAUDE_USAGE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.expanduser(env) if env else os.path.expanduser("~/.claude")


def _default_claude_desktop_sessions() -> str:
    """Locate the Claude Desktop per-session metadata dir for the current platform.

    These files only carry titles/model/effort keyed by cliSessionId; the actual
    transcripts live under the shared ~/.claude/projects tree. Override with
    CLAUDE_DESKTOP_SESSIONS if your install is non-standard.
    """
    env = os.environ.get("CLAUDE_DESKTOP_SESSIONS")
    if env:
        return os.path.expanduser(env)
    if sys.platform == "darwin":
        root = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        root = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
    else:  # linux / other unix
        root = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(root, "Claude", "claude-code-sessions")
