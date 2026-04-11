#!/usr/bin/env bash
set -euo pipefail

REPO="Mouriya-Emma/moat-browser"
BIN="moat-x86_64-linux"
INSTALL_DIR="${MOAT_INSTALL_DIR:-$HOME/.local/bin}"

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI required (private repo). Install from https://cli.github.com"
  exit 1
fi

mkdir -p "$INSTALL_DIR"

echo "Downloading moat CLI..."
gh release download --repo "$REPO" --pattern "$BIN" --dir "$INSTALL_DIR" --clobber
mv "${INSTALL_DIR}/${BIN}" "${INSTALL_DIR}/moat"
chmod +x "${INSTALL_DIR}/moat"

echo "Installed to ${INSTALL_DIR}/moat"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "WARNING: ${INSTALL_DIR} is not in your PATH."
  echo "Add it with:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

"${INSTALL_DIR}/moat" --version
