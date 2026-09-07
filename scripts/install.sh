#!/usr/bin/env bash
set -euo pipefail

readonly REPO="Mouriya-Emma/moat-browser"
readonly BIN="moat-x86_64-linux"
readonly INSTALL_DIR="${MOAT_INSTALL_DIR:-/usr/local/bin}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/install.sh [--asset PATH --sha256 SHA256]

With --asset and --sha256 (or MOAT_INSTALL_ASSET and MOAT_INSTALL_SHA256),
install exactly the supplied local Linux x86_64 asset after verifying its
SHA-256 digest. Without either form, download the latest private release via
the GitHub CLI as before.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

asset_env_set=0
sha_env_set=0
[[ ${MOAT_INSTALL_ASSET+x} ]] && asset_env_set=1
[[ ${MOAT_INSTALL_SHA256+x} ]] && sha_env_set=1
asset_path="${MOAT_INSTALL_ASSET:-}"
expected_sha="${MOAT_INSTALL_SHA256:-}"
asset_cli_set=0
sha_cli_set=0

while (($# > 0)); do
  case "$1" in
    --asset)
      (($# >= 2)) || die "--asset requires a path"
      asset_cli_set=1
      asset_path="$2"
      shift 2
      ;;
    --asset=*)
      asset_cli_set=1
      asset_path="${1#*=}"
      shift
      ;;
    --sha256)
      (($# >= 2)) || die "--sha256 requires a 64-character hexadecimal digest"
      sha_cli_set=1
      expected_sha="$2"
      shift 2
      ;;
    --sha256=*)
      sha_cli_set=1
      expected_sha="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

if ((asset_cli_set)) && ((asset_env_set)) && [[ "$MOAT_INSTALL_ASSET" != "$asset_path" ]]; then
  die "--asset conflicts with MOAT_INSTALL_ASSET"
fi
if ((sha_cli_set)) && ((sha_env_set)) && [[ "$MOAT_INSTALL_SHA256" != "$expected_sha" ]]; then
  die "--sha256 conflicts with MOAT_INSTALL_SHA256"
fi
[[ -n "$INSTALL_DIR" ]] || die "MOAT_INSTALL_DIR must not be empty"

TMPDIR="$(mktemp -d)"
stage_path=""
cleanup() {
  rm -rf "$TMPDIR"
  if [[ -n "$stage_path" && -e "$stage_path" ]]; then
    if [[ -w "$INSTALL_DIR" ]]; then
      rm -f "$stage_path"
    elif command -v sudo >/dev/null 2>&1; then
      sudo rm -f "$stage_path" || true
    fi
  fi
}
trap cleanup EXIT

source_asset=""
explicit_asset=0
if ((asset_cli_set || sha_cli_set || asset_env_set || sha_env_set)); then
  explicit_asset=1
  [[ -n "$asset_path" && -n "$expected_sha" ]] || die "explicit candidate installs require both an asset path and SHA-256 digest"
  [[ -f "$asset_path" && -r "$asset_path" ]] || die "candidate asset is not a readable regular file: $asset_path"
  [[ "$expected_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "candidate SHA-256 digest must contain exactly 64 hexadecimal characters"
  source_asset="$asset_path"
else
  command -v gh >/dev/null 2>&1 || die "gh CLI required for private release downloads"
  echo "Downloading moat CLI from ${REPO}..."
  gh release download --repo "$REPO" --pattern "$BIN" --dir "$TMPDIR" --clobber
  source_asset="${TMPDIR}/${BIN}"
  [[ -f "$source_asset" && -r "$source_asset" ]] || die "release download did not produce ${BIN}"
fi

if ((explicit_asset)); then
  actual_sha=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha="$(sha256sum "$source_asset" | cut -d ' ' -f 1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha="$(shasum -a 256 "$source_asset" | cut -d ' ' -f 1)"
  else
    die "sha256sum or shasum is required to verify an explicit candidate asset"
  fi
  expected_sha="$(printf '%s' "$expected_sha" | tr '[:upper:]' '[:lower:]')"
  [[ "$actual_sha" == "$expected_sha" ]] || die "candidate SHA-256 mismatch for $source_asset"
  echo "Verified candidate asset SHA-256: ${actual_sha}"
fi

if [ -d "$INSTALL_DIR" ]; then
  :
elif mkdir -p "$INSTALL_DIR" 2>/dev/null; then
  :
else
  command -v sudo >/dev/null 2>&1 || die "cannot create install directory ${INSTALL_DIR}; sudo is required"
  sudo mkdir -p "$INSTALL_DIR"
fi

# Stage inside the destination directory and rename only after validation so a
# bad candidate cannot replace an existing installation.
stage_path="${INSTALL_DIR}/.moat-install.$$"
if [ -w "$INSTALL_DIR" ]; then
  install -m 0755 "$source_asset" "$stage_path"
  mv -f "$stage_path" "${INSTALL_DIR}/moat"
else
  command -v sudo >/dev/null 2>&1 || die "install directory ${INSTALL_DIR} is not writable; sudo is required"
  sudo install -m 0755 "$source_asset" "$stage_path"
  sudo mv -f "$stage_path" "${INSTALL_DIR}/moat"
fi
stage_path=""

echo "Installed to ${INSTALL_DIR}/moat"
"${INSTALL_DIR}/moat" --version
