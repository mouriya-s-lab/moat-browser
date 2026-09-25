import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ObservedBrowserVersion } from "@moat-browser/types";
import type { Result } from "./container-manager.js";

// The only source of the Chrome version (#280 K1): the chromium entry of the
// browsers.json shipped inside the patchright-core that this controller has
// actually installed. Images derive the same value at build time; the
// controller reads it at startup and compares every agent-chrome against it.

const VERSION = /(\d+\.\d+\.\d+\.\d+)/;

type BrowsersJson = {
  readonly browsers: ReadonlyArray<{ readonly name: string; readonly browserVersion?: string }>;
};

function isBrowserEntry(value: unknown): value is BrowsersJson["browsers"][number] {
  return typeof value === "object" && value !== null && "name" in value && typeof value.name === "string";
}

function isBrowsersJson(value: unknown): value is BrowsersJson {
  if (typeof value !== "object" || value === null || !("browsers" in value)) return false;
  const browsers: unknown = value.browsers;
  return Array.isArray(browsers) && browsers.every((entry: unknown) => isBrowserEntry(entry));
}

export async function loadExpectedBrowserVersion(): Promise<Result<string, string>> {
  const require = createRequire(import.meta.url);
  let browsersJsonPath: string;
  try {
    const patchrightEntry = require.resolve("patchright/package.json");
    const corePackage = require.resolve("patchright-core/package.json", { paths: [dirname(patchrightEntry)] });
    browsersJsonPath = join(dirname(corePackage), "browsers.json");
  } catch (err) {
    return { _tag: "Err", error: `cannot resolve installed patchright-core: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(browsersJsonPath, "utf8"));
  } catch (err) {
    return { _tag: "Err", error: `cannot read ${browsersJsonPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isBrowsersJson(parsed)) {
    return { _tag: "Err", error: `${browsersJsonPath} has no browsers array` };
  }
  const version = parsed.browsers.find((b) => b.name === "chromium")?.browserVersion;
  const match = version === undefined ? null : VERSION.exec(version);
  if (match === null || match[1] !== version) {
    return { _tag: "Err", error: `${browsersJsonPath} has no four-part chromium browserVersion` };
  }
  return { _tag: "Ok", value: match[1] };
}

/** Parses the `Browser` field of a CDP `/json/version` body, e.g. `Chrome/153.0.8010.12`. */
export function parseObservedBrowserVersion(body: unknown): ObservedBrowserVersion {
  const browser =
    typeof body === "object" && body !== null && "Browser" in body && typeof body.Browser === "string"
      ? body.Browser
      : undefined;
  if (browser === undefined) {
    return { _tag: "Unparseable", raw: JSON.stringify(body) ?? String(body) };
  }
  const match = /^(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)$/.exec(browser);
  return match === null ? { _tag: "Unparseable", raw: browser } : { _tag: "Parsed", version: match[1] };
}
