#!/usr/bin/env bash
# Usage: verify-chrome-versions.sh <controller-image> <user-chrome-image> <agent-chrome-image>
# Compare candidate image contents, not registry metadata or an independent version pin.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <controller-image> <user-chrome-image> <agent-chrome-image>" >&2
  exit 2
fi

controller=$(docker run --rm --platform linux/amd64 --entrypoint node "$1" -e '
  const path = require("node:path");
  const core = require.resolve("patchright-core/package.json", { paths: [require.resolve("patchright")] });
  const version = require(path.join(path.dirname(core), "browsers.json"))
    .browsers.find(browser => browser.name === "chromium")?.browserVersion;
  if (typeof version !== "string" || !/^\d+(\.\d+){3}$/.test(version)) {
    console.error("controller: invalid chromium.browserVersion in installed patchright-core");
    process.exit(1);
  }
  console.log(version);
')

browser_version() {
  local raw
  if ! raw=$(docker run --rm --platform linux/amd64 --entrypoint /opt/chrome/chrome "$1" --version); then
    echo "cannot read Chrome for Testing version from $1" >&2
    return 1
  fi
  if [[ ! "$raw" =~ ^[^[:digit:]]*([[:digit:]]+(\.[[:digit:]]+){3})[^[:digit:]]*$ ]]; then
    echo "invalid Chrome for Testing --version output from $1: $raw" >&2
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

user=$(browser_version "$2")
agent=$(browser_version "$3")
printf 'controller=%s\nuser-chrome=%s\nagent-chrome=%s\n' "$controller" "$user" "$agent"

if [[ "$controller" != "$user" || "$controller" != "$agent" ]]; then
  echo 'Chrome version gate failed: all three candidate images must match' >&2
  exit 1
fi
