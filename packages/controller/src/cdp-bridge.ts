import { chromium } from "patchright";
import type { Browser, BrowserContext, Locator, Page } from "patchright";
import type {
  BrowserCommand,
  CommandResultData,
  ControllerError,
  CookieEntry,
  EvalResult,
  LocatorResult,
  NavigateResult,
  ScreenshotResult,
  SnapshotResult,
  TabInfo,
  TabResult,
  CookiesResult,
  VoidResult,
  WaitResult,
} from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";
import type { RefStore } from "./ref-store.js";

// ─── Result ADT ───

export type Result<T, E> =
  | { readonly _tag: "Ok"; readonly value: T }
  | { readonly _tag: "Err"; readonly error: E };

function ok<T>(value: T): Result<T, never> {
  return { _tag: "Ok", value };
}

function err<E>(error: E): Result<never, E> {
  return { _tag: "Err", error };
}

// ─── CdpConnection ───

export type CdpConnection = {
  readonly browser: Browser;
  readonly context: BrowserContext;
};

export async function connectCDP(cdpUrl: string): Promise<CdpConnection> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  return { browser, context };
}

// ─── Tab tracking ───

let activeTabIndex = 0;

// ─── Locator subaction type ───

type LocatorSubaction = "click" | "fill" | "type" | "check" | "uncheck" | "hover";

// ─── executeLocatorAction ───

async function executeLocatorAction(
  locator: Locator,
  subaction: LocatorSubaction | undefined,
  value?: string,
): Promise<Result<CommandResultData, ControllerError>> {
  switch (subaction) {
    case undefined: {
      const count = await locator.count();
      if (count === 0) return err({ _tag: "ElementNotFound" } as const);
      const result: LocatorResult = { _tag: "LocatorResult", found: true, count };
      return ok(result);
    }

    case "click":
      await locator.click();
      return ok({ _tag: "VoidResult" } as const);

    case "fill":
      await locator.fill(value!);
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      await locator.pressSequentially(value!);
      return ok({ _tag: "VoidResult" } as const);

    case "check":
      await locator.check();
      return ok({ _tag: "VoidResult" } as const);

    case "uncheck":
      await locator.uncheck();
      return ok({ _tag: "VoidResult" } as const);

    case "hover":
      await locator.hover();
      return ok({ _tag: "VoidResult" } as const);

    default:
      return exhaustive(subaction);
  }
}

// ─── resolveLocator ───

function resolveLocator(
  page: Page,
  refStore: RefStore,
  sessionId: string,
  ref?: string,
  selector?: string,
): Locator | null {
  if (ref) return refStore.resolve(sessionId, ref) ?? null;
  if (selector) return page.locator(selector);
  return null;
}

// ─── executeElementAction ───

async function executeElementAction(
  page: Page,
  refStore: RefStore,
  sessionId: string,
  ref: string | undefined,
  selector: string | undefined,
  action: "click" | "fill" | "type" | "hover",
  value?: string,
): Promise<Result<CommandResultData, ControllerError>> {
  const locator = resolveLocator(page, refStore, sessionId, ref, selector);
  if (!locator) return err({ _tag: "ElementNotFound", selector: ref ?? selector } as const);

  switch (action) {
    case "click":
      await locator.click();
      return ok({ _tag: "VoidResult" } as const);

    case "fill":
      await locator.fill(value!);
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      await locator.pressSequentially(value!);
      return ok({ _tag: "VoidResult" } as const);

    case "hover":
      await locator.hover();
      return ok({ _tag: "VoidResult" } as const);

    default:
      return exhaustive(action);
  }
}

// ─── buildAriaSnapshot ───

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "option",
]);

// Matches lines like "- button "Submit"" or "  - textbox "Name" [attr=val]"
const ARIA_LINE_RE = /^(\s*- )(\w+)(?: "([^"]*)")?(.*)$/;

async function buildAriaSnapshot(
  page: Page,
  refStore: RefStore,
  sessionId: string,
): Promise<string> {
  const snapshot = await page.ariaSnapshot();
  const refs = new Map<string, Locator>();
  let counter = 1;

  const annotated = snapshot.split("\n").map((line) => {
    const m = ARIA_LINE_RE.exec(line);
    if (!m) return line;

    const [, indent, role, name, rest] = m;
    if (!INTERACTIVE_ROLES.has(role)) return line;

    const key = `@e${counter}`;
    const locator = name
      ? page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true })
      : page.getByRole(role as Parameters<Page["getByRole"]>[0]);
    refs.set(key, locator);
    counter++;

    return name
      ? `${indent}${key} ${role} "${name}"${rest}`
      : `${indent}${key} ${role}${rest}`;
  }).join("\n");

  refStore.update(sessionId, refs);
  return annotated;
}

// ─── buildTabList ───

async function buildTabList(
  context: BrowserContext,
  activeIndex: number,
): Promise<ReadonlyArray<TabInfo>> {
  return Promise.all(
    context.pages().map(async (p, i): Promise<TabInfo> => ({
      index: i,
      url: p.url(),
      title: await p.title(),
      active: i === activeIndex,
    })),
  );
}

// ─── Error mapping (§8.7) ───

function mapPlaywrightError(e: unknown): ControllerError {
  if (!(e instanceof Error)) {
    return { _tag: "CommandFailed", message: String(e) };
  }

  const msg = e.message;

  if (e.name === "TimeoutError" || msg.includes("Timeout")) {
    if (msg.includes("waiting for locator") || msg.includes("waiting for selector")) {
      return { _tag: "ElementNotFound", selector: undefined };
    }
    return { _tag: "Timeout", operation: msg };
  }

  if (msg.includes("Target closed") || msg.includes("Execution context destroyed")) {
    return { _tag: "CdpDisconnected", containerId: "" };
  }

  return { _tag: "CommandFailed", message: msg };
}

// ─── executeCommand ───

export async function executeCommand(
  context: BrowserContext,
  command: BrowserCommand,
  refStore: RefStore,
  sessionId: string,
): Promise<Result<CommandResultData, ControllerError>> {
  const page = context.pages()[activeTabIndex] ?? context.pages()[0];

  try {
    switch (command.action) {
      case "navigate": {
        await page.goto(command.url, { waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "back": {
        await page.goBack({ waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "forward": {
        await page.goForward({ waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "reload": {
        await page.reload({ waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "getbyrole": {
        let loc = page.getByRole(command.role as Parameters<Page["getByRole"]>[0], {
          name: command.name,
          exact: command.exact,
        });
        if (command.nth !== undefined) {
          loc = loc.nth(command.nth);
        }
        return executeLocatorAction(loc, command.subaction, command.value);
      }

      case "getbylabel":
        return executeLocatorAction(
          page.getByLabel(command.label, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbyplaceholder":
        return executeLocatorAction(
          page.getByPlaceholder(command.placeholder, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbytext":
        return executeLocatorAction(
          page.getByText(command.text, { exact: command.exact }),
          command.subaction,
        );

      case "getbyalttext":
        return executeLocatorAction(
          page.getByAltText(command.text, { exact: command.exact }),
          command.subaction,
        );

      case "getbytitle":
        return executeLocatorAction(
          page.getByTitle(command.text, { exact: command.exact }),
          command.subaction,
        );

      case "getbytestid":
        return executeLocatorAction(
          page.getByTestId(command.testId),
          command.subaction, command.value,
        );

      case "click":
        return executeElementAction(page, refStore, sessionId, command.ref, command.selector, "click");

      case "fill":
        return executeElementAction(page, refStore, sessionId, command.ref, command.selector, "fill", command.value);

      case "type":
        return executeElementAction(page, refStore, sessionId, command.ref, command.selector, "type", command.text);

      case "hover":
        return executeElementAction(page, refStore, sessionId, command.ref, command.selector, "hover");

      case "snapshot": {
        const snapshot = await buildAriaSnapshot(page, refStore, sessionId);
        const result: SnapshotResult = { _tag: "SnapshotResult", snapshot };
        return ok(result);
      }

      case "screenshot": {
        const format = command.format ?? "png";
        const buf = await page.screenshot({
          type: format,
          quality: format === "jpeg" ? (command.quality ?? 80) : undefined,
        });
        const result: ScreenshotResult = {
          _tag: "ScreenshotResult",
          base64: buf.toString("base64"),
          format,
        };
        return ok(result);
      }

      case "eval": {
        const raw = await page.evaluate(command.code);
        const result: EvalResult = { _tag: "EvalResult", result: JSON.stringify(raw) };
        return ok(result);
      }

      case "press":
        await page.keyboard.press(command.key);
        return ok({ _tag: "VoidResult" } as const);

      case "scroll":
        await page.evaluate(({ dir, amt }) => {
          const m: Record<string, [number, number]> = {
            up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
          };
          const [x, y] = m[dir]!;
          window.scrollBy(x * amt, y * amt);
        }, { dir: command.direction, amt: command.amount ?? 300 });
        return ok({ _tag: "VoidResult" } as const);

      case "tab_list": {
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_new": {
        const newPage = await context.newPage();
        if (command.url) await newPage.goto(command.url);
        activeTabIndex = context.pages().length - 1;
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_switch": {
        activeTabIndex = command.index;
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_close": {
        const closeIndex = command.index ?? activeTabIndex;
        await context.pages()[closeIndex].close();
        if (activeTabIndex >= context.pages().length) {
          activeTabIndex = Math.max(0, context.pages().length - 1);
        }
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "cookies_get": {
        const raw = await context.cookies(command.url ? [command.url] : undefined);
        const cookies: ReadonlyArray<CookieEntry> = raw.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite as CookieEntry["sameSite"],
        }));
        const result: CookiesResult = { _tag: "CookiesResult", cookies };
        return ok(result);
      }

      case "cookies_clear":
        await context.clearCookies();
        return ok({ _tag: "VoidResult" } as const);

      case "wait": {
        if (command.selector) {
          const state = (command.state ?? "visible") as "visible" | "hidden" | "attached" | "detached";
          await page.locator(command.selector).waitFor({ state, timeout: command.timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "selector" };
          return ok(wr);
        }
        if (command.text) {
          await page.getByText(command.text).waitFor({ timeout: command.timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "text" };
          return ok(wr);
        }
        await new Promise<void>((r) => setTimeout(r, command.time ?? 1000));
        const wr: WaitResult = { _tag: "WaitResult", waited: "timeout" };
        return ok(wr);
      }

      case "waitforurl": {
        await page.waitForURL(command.url, { timeout: command.timeout });
        const wr: WaitResult = { _tag: "WaitResult", waited: "url", url: page.url() };
        return ok(wr);
      }

      case "waitforloadstate": {
        const state = command.state as "load" | "domcontentloaded" | "networkidle";
        await page.waitForLoadState(state, { timeout: command.timeout });
        const wr: WaitResult = { _tag: "WaitResult", waited: "loadstate", state: command.state };
        return ok(wr);
      }

      case "waitforfunction": {
        const handle = await page.waitForFunction(command.expression, undefined, { timeout: command.timeout });
        const val = await handle.jsonValue();
        const wr: WaitResult = { _tag: "WaitResult", waited: "function", result: JSON.stringify(val) };
        return ok(wr);
      }

      default:
        return exhaustive(command);
    }
  } catch (e) {
    return err(mapPlaywrightError(e));
  }
}
