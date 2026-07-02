"""Compatibility alias for the packaged llmly analyzer module."""

from __future__ import annotations

import sys

from llmly import analyzer as _analyzer

sys.modules[__name__] = _analyzer
