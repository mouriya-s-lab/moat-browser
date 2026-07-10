#!/usr/bin/env bash
# Install the sync-to-komodo toolchain into a job-local bin directory.

set -euo pipefail

SOPS_VERSION="${SOPS_VERSION:-v3.13.0}"
YQ_VERSION="${YQ_VERSION:-v4.53.2}"
JQ_VERSION="${JQ_VERSION:-jq-1.7.1}"
AGE_VERSION="${AGE_VERSION:-v1.2.1}"

if [[ -z "${RUNNER_TEMP:-}" ]]; then
  echo "::error::RUNNER_TEMP is not set"
  exit 1
fi

install_dir="${1:-${RUNNER_TEMP}/sync-toolchain/bin}"
download_dir="${RUNNER_TEMP}/sync-toolchain/downloads"
mkdir -p "$install_dir" "$download_dir"

if ! command -v curl >/dev/null 2>&1; then
  echo "::error::curl is required before the sync toolchain can be installed"
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "::error::tar is required before age can be installed"
  exit 1
fi

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "::error::unsupported OS $(uname -s); sync-to-komodo runs on Linux"
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    arch="amd64"
    ;;
  aarch64 | arm64)
    arch="arm64"
    ;;
  *)
    echo "::error::unsupported architecture $(uname -m)"
    exit 1
    ;;
esac

download() {
  local url="$1"
  local dest="$2"

  curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"
}

install_binary() {
  local name="$1"
  local url="$2"
  local dest="${download_dir}/${name}"

  download "$url" "$dest"
  install -m 0755 "$dest" "${install_dir}/${name}"
  "${install_dir}/${name}" --version 2>&1 | head -1
}

install_binary sops \
  "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.${arch}"
install_binary yq \
  "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}"
install_binary jq \
  "https://github.com/jqlang/jq/releases/download/${JQ_VERSION}/jq-linux-${arch}"

age_archive="${download_dir}/age-${AGE_VERSION}-linux-${arch}.tar.gz"
download \
  "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${arch}.tar.gz" \
  "$age_archive"
rm -rf "${download_dir}/age"
tar -xzf "$age_archive" -C "$download_dir"
install -m 0755 "${download_dir}/age/age" "${install_dir}/age"
"${install_dir}/age" --version

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
fi

echo "sync toolchain installed in ${install_dir}"
