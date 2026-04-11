#!/usr/bin/env bash
set -euo pipefail

REPO="Mouriya-Emma/moat-browser"
BIN="moat-x86_64-linux"
INSTALL_DIR="${MOAT_INSTALL_DIR:-$HOME/.local/bin}"

mkdir -p "$INSTALL_DIR"

echo "Downloading moat CLI..."
curl -fsSL "https://github.com/${REPO}/releases/latest/download/${BIN}" -o "${INSTALL_DIR}/moat"
chmod +x "${INSTALL_DIR}/moat"

echo "Installed to ${INSTALL_DIR}/moat"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "WARNING: ${INSTALL_DIR} is not in your PATH."
  echo "Add it with:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

"${INSTALL_DIR}/moat" --version
