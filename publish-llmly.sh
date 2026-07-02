#!/usr/bin/env sh

set -eu

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT_DIR"

PYPROJECT_FILE="$ROOT_DIR/pyproject.toml"
INIT_FILE="$ROOT_DIR/llmly/__init__.py"

# Optionally load environment variables from .env (if present).
if [ -f ".env" ]; then
  echo "==> Loading environment from .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

TARGET="${1:-prod}"  # "prod" (default) or "test"

if [ "$TARGET" = "test" ]; then
  PUBLISH_URL="https://test.pypi.org/legacy/"
  CHECK_URL="https://test.pypi.org/simple/llmly/"
  TOKEN_VAR="TEST_PYPI_TOKEN"
  echo "==> Publishing llmly (TestPyPI)"
elif [ "$TARGET" = "prod" ]; then
  PUBLISH_URL=""
  CHECK_URL="https://pypi.org/simple/llmly/"
  TOKEN_VAR="PYPI_TOKEN"
  echo "==> Publishing llmly (PyPI)"
else
  echo "Usage: $0 [prod|test]" >&2
  exit 1
fi

TOKEN="$(eval "printf '%s' \"\${$TOKEN_VAR:-}\"")"
if [ -z "${TOKEN}" ]; then
  echo "Error: $TOKEN_VAR is not set. Set it in your environment or .env first." >&2
  exit 1
fi

if [ ! -f "$PYPROJECT_FILE" ]; then
  echo "Error: pyproject.toml not found at $PYPROJECT_FILE" >&2
  exit 1
fi

PROJECT_NAME_LINE="$(grep '^name = "' "$PYPROJECT_FILE" || true)"
PROJECT_NAME="$(printf '%s\n' "$PROJECT_NAME_LINE" | sed -E 's/^name = "([^"]+)".*/\1/')"
if [ "$PROJECT_NAME" != "llmly" ]; then
  echo "Error: pyproject.toml project name is '$PROJECT_NAME', expected 'llmly'." >&2
  echo "Refusing to publish so the wrong package name is not uploaded." >&2
  exit 1
fi

CURRENT_VERSION_LINE="$(grep '^version = "' "$PYPROJECT_FILE" || true)"
if [ -z "$CURRENT_VERSION_LINE" ]; then
  echo 'Error: Could not find a line starting with: version = "<version>" in pyproject.toml' >&2
  exit 1
fi

CURRENT_VERSION="$(printf '%s\n' "$CURRENT_VERSION_LINE" | sed -E 's/^version = "([^"]+)".*/\1/')"

if ! printf '%s' "$CURRENT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: CURRENT_VERSION '$CURRENT_VERSION' is not in MAJOR.MINOR.PATCH format" >&2
  exit 1
fi

MAJOR="$(printf '%s' "$CURRENT_VERSION" | cut -d. -f1)"
MINOR="$(printf '%s' "$CURRENT_VERSION" | cut -d. -f2)"
PATCH="$(printf '%s' "$CURRENT_VERSION" | cut -d. -f3)"
PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

echo "==> Bumping Python package version: $CURRENT_VERSION -> $NEW_VERSION"

tmp_pyproject="$(mktemp)"
sed -E "s/^version = \"${CURRENT_VERSION}\"/version = \"${NEW_VERSION}\"/" "$PYPROJECT_FILE" > "$tmp_pyproject"
mv "$tmp_pyproject" "$PYPROJECT_FILE"

if [ -f "$INIT_FILE" ]; then
  tmp_init="$(mktemp)"
  sed -E "s/^__version__ = \"${CURRENT_VERSION}\"/__version__ = \"${NEW_VERSION}\"/" "$INIT_FILE" > "$tmp_init"
  mv "$tmp_init" "$INIT_FILE"
fi

echo "==> Running checks"
uv run python -m py_compile app.py analyzer/__init__.py llmly/app.py llmly/__init__.py llmly/__main__.py llmly/analyzer/*.py tests/test_analyzer.py
uv run python -m pytest
if [ -d "llmly/static/js" ]; then
  for js_file in llmly/static/js/*.mjs; do
    node --check "$js_file"
  done
elif [ -f "llmly/static/app.js" ]; then
  node --check llmly/static/app.js
elif [ -d "static/js" ]; then
  for js_file in static/js/*.mjs; do
    node --check "$js_file"
  done
elif [ -f "static/app.js" ]; then
  node --check static/app.js
fi

echo "==> Building llmly at version $NEW_VERSION"
mkdir -p dist
rm -f dist/*
uv build

echo "==> Publishing llmly"
if [ -n "$PUBLISH_URL" ]; then
  uv publish --publish-url "$PUBLISH_URL" --check-url "$CHECK_URL" --token "$TOKEN"
else
  uv publish --check-url "$CHECK_URL" --token "$TOKEN"
fi

echo "Finished publishing llmly $NEW_VERSION ($TARGET)"
