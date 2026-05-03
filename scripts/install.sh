#!/usr/bin/env bash
set -euo pipefail

readonly REPO="Mouriya-Emma/moat-browser"
readonly BIN="moat-x86_64-linux"
readonly INSTALL_DIR="${MOAT_INSTALL_DIR:-/usr/local/bin}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI required for private release downloads." >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading moat CLI from ${REPO}..."
gh release download --repo "$REPO" --pattern "$BIN" --dir "$TMPDIR" --clobber

if [ -d "$INSTALL_DIR" ]; then
  :
elif mkdir -p "$INSTALL_DIR" 2>/dev/null; then
  :
else
  sudo mkdir -p "$INSTALL_DIR"
fi

if [ -w "$INSTALL_DIR" ]; then
  install -m 0755 "${TMPDIR}/${BIN}" "${INSTALL_DIR}/moat"
else
  sudo install -m 0755 "${TMPDIR}/${BIN}" "${INSTALL_DIR}/moat"
fi

echo "Installed to ${INSTALL_DIR}/moat"
"${INSTALL_DIR}/moat" --version
