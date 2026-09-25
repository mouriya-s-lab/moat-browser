// Derives the Chrome for Testing version for the browser images (#280 K1/K2).
//
// The only source is the chromium entry of browsers.json inside the
// patchright-core that packages/controller installs. Both pins on the way
// there must be exact, otherwise the version the images get could differ
// from the one the controller installs, so anything else fails the build.
//
// Usage: node chrome-anchor.mjs <path to packages/controller/package.json>
// Prints the four-part version on stdout; exits non-zero on any failure.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// npm treats a leading "v" as part of an exact version (patchright 1.59.2
// declares "patchright-core": "v1.59.2"); ranges and tags are rejected.
const EXACT_SEMVER = /^v?(\d+\.\d+\.\d+)$/;
const FOUR_PART = /^\d+\.\d+\.\d+\.\d+$/;

function fail(message) {
  process.stderr.write(`chrome-anchor: ${message}\n`);
  process.exit(1);
}

const manifestPath = process.argv[2];
if (!manifestPath) fail("missing path to packages/controller/package.json");

const patchright = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies?.patchright;
if (typeof patchright !== "string" || !EXACT_SEMVER.test(patchright)) {
  fail(`packages/controller must pin patchright to an exact version, found ${JSON.stringify(patchright)}`);
}

const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const coreSpec = JSON.parse(npm(["view", `patchright@${patchright}`, "dependencies.patchright-core", "--json"]));
const core = typeof coreSpec === "string" ? EXACT_SEMVER.exec(coreSpec)?.[1] : undefined;
if (core === undefined) {
  fail(`patchright@${patchright} does not pin patchright-core exactly, found ${JSON.stringify(coreSpec)}`);
}

const workDir = mkdtempSync(join(tmpdir(), "chrome-anchor-"));
const tarball = npm(["pack", `patchright-core@${core}`, "--silent"], workDir).split("\n").pop();
const browsersJson = execFileSync("tar", ["-xzOf", join(workDir, tarball), "package/browsers.json"], { encoding: "utf8" });
const chromium = JSON.parse(browsersJson).browsers?.find((browser) => browser.name === "chromium");
const version = chromium?.browserVersion;
if (typeof version !== "string" || !FOUR_PART.test(version)) {
  fail(`patchright-core@${core} browsers.json has no four-part chromium browserVersion`);
}

process.stderr.write(`chrome-anchor: patchright@${patchright} -> patchright-core@${core} -> chromium ${version}\n`);
process.stdout.write(`${version}\n`);
