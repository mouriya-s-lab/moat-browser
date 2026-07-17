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
  GetTextResult,
  GetValueResult,
  GetHtmlResult,
  PageUrlResult,
  PageTitleResult,
  CountResult,
  BoundingBoxResult,
  ElementStylesResult,
  StorageResult,
  BooleanResult,
  BatchResult,
  BatchResultEntry,
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

// ─── Tab tracking (per-session) ───

const sessionTabIndex = new Map<string, number>();

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
  const nthByRole = new Map<string, number>();

  const annotated = snapshot.split("\n").map((line) => {
    const m = ARIA_LINE_RE.exec(line);
    if (!m) return line;

    const [, indent, role, name, rest] = m;
    if (!INTERACTIVE_ROLES.has(role)) return line;

    const key = `@e${counter}`;
    const locator = name
      ? page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true })
      : (() => {
          const n = nthByRole.get(role) ?? 0;
          nthByRole.set(role, n + 1);
          return page.getByRole(role as Parameters<Page["getByRole"]>[0]).nth(n);
        })();
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
  let activeTabIndex = sessionTabIndex.get(sessionId) ?? 0;
  const page = context.pages()[activeTabIndex] ?? context.pages()[0];

  try {
    switch (command.action) {
      case "navigate": {
        await page.goto(command.url, { waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "back": {
        const urlBefore = page.url();
        try {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 3000 });
        } catch {
          if (page.url() === urlBefore) {
            return err({ _tag: "CommandFailed", message: "No back history" } as const);
          }
        }
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "forward": {
        const urlBefore = page.url();
        try {
          await page.goForward({ waitUntil: "domcontentloaded", timeout: 3000 });
        } catch {
          if (page.url() === urlBefore) {
            return err({ _tag: "CommandFailed", message: "No forward history" } as const);
          }
        }
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
        sessionTabIndex.set(sessionId, activeTabIndex);
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_switch": {
        activeTabIndex = command.index;
        sessionTabIndex.set(sessionId, activeTabIndex);
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_close": {
        const closeIndex = command.index ?? activeTabIndex;
        await context.pages()[closeIndex].close();
        if (activeTabIndex >= context.pages().length) {
          activeTabIndex = Math.max(0, context.pages().length - 1);
        }
        sessionTabIndex.set(sessionId, activeTabIndex);
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

      // ─── Get (element property queries) ───

      case "gettext": {
        const text = await page.locator(command.selector).textContent() ?? "";
        const r: GetTextResult = { _tag: "GetTextResult", text };
        return ok(r);
      }

      case "innertext": {
        const text = await page.locator(command.selector).innerText();
        const r: GetTextResult = { _tag: "GetTextResult", text };
        return ok(r);
      }

      case "innerhtml": {
        const html = await page.locator(command.selector).innerHTML();
        const r: GetHtmlResult = { _tag: "GetHtmlResult", html };
        return ok(r);
      }

      case "inputvalue": {
        const value = await page.locator(command.selector).inputValue();
        const r: GetValueResult = { _tag: "GetValueResult", value };
        return ok(r);
      }

      case "getattribute": {
        const value = await page.locator(command.selector).getAttribute(command.attribute) ?? "";
        const r: GetValueResult = { _tag: "GetValueResult", value };
        return ok(r);
      }

      case "url": {
        const r: PageUrlResult = { _tag: "PageUrlResult", url: page.url() };
        return ok(r);
      }

      case "title": {
        const r: PageTitleResult = { _tag: "PageTitleResult", title: await page.title() };
        return ok(r);
      }

      case "count": {
        const r: CountResult = { _tag: "CountResult", count: await page.locator(command.selector).count() };
        return ok(r);
      }

      case "boundingbox": {
        const r: BoundingBoxResult = {
          _tag: "BoundingBoxResult",
          box: await page.locator(command.selector).boundingBox(),
        };
        return ok(r);
      }

      case "styles": {
        const elements = await page.locator(command.selector).evaluateAll((nodes) =>
          nodes.map((node) => {
            const element = node as HTMLElement;
            const rect = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            return {
              tag: element.tagName.toLowerCase(),
              text: element.innerText ?? element.textContent ?? "",
              box: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              styles: {
                fontSize: styles.fontSize,
                fontWeight: styles.fontWeight,
                fontFamily: styles.fontFamily,
                color: styles.color,
                backgroundColor: styles.backgroundColor,
                borderRadius: styles.borderRadius,
              },
            };
          }),
        );
        const r: ElementStylesResult = { _tag: "ElementStylesResult", elements };
        return ok(r);
      }

      // ─── Is (element state queries) ───

      case "isvisible": {
        const visible = await page.locator(command.selector).isVisible();
        const r: BooleanResult = { _tag: "BooleanResult", visible };
        return ok(r);
      }

      case "isenabled": {
        const enabled = await page.locator(command.selector).isEnabled();
        const r: BooleanResult = { _tag: "BooleanResult", enabled };
        return ok(r);
      }

      case "ischecked": {
        const checked = await page.locator(command.selector).isChecked();
        const r: BooleanResult = { _tag: "BooleanResult", checked };
        return ok(r);
      }

      // ─── evaluate alias ───

      case "evaluate": {
        const raw = await page.evaluate(command.script);
        const r: EvalResult = { _tag: "EvalResult", result: JSON.stringify(raw) };
        return ok(r);
      }

      // ─── batch ───

      case "batch": {
        const entries: BatchResultEntry[] = [];
        for (const sub of command.commands) {
          const subResult = await executeCommand(context, sub, refStore, sessionId);
          if (subResult._tag === "Ok") {
            entries.push({ success: true, data: subResult.value });
          } else {
            entries.push({ success: false, error: subResult.error._tag });
            if (command.bail) break;
          }
        }
        const r: BatchResult = { _tag: "BatchResult", results: entries };
        return ok(r);
      }

      // ─── close (handled by ws-server as deregister) ───

      case "close":
        return ok({ _tag: "VoidResult" } as const);

      // ─── P1 element operations ───

      case "dblclick":
        await page.locator(command.selector).dblclick();
        return ok({ _tag: "VoidResult" } as const);

      case "check":
        await page.locator(command.selector).check();
        return ok({ _tag: "VoidResult" } as const);

      case "uncheck":
        await page.locator(command.selector).uncheck();
        return ok({ _tag: "VoidResult" } as const);

      case "select": {
        const values = Array.isArray(command.values) ? command.values : [command.values];
        await page.locator(command.selector).selectOption(values);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "focus":
        await page.locator(command.selector).focus();
        return ok({ _tag: "VoidResult" } as const);

      case "keyboard":
        if (command.subaction === "type") {
          await page.keyboard.type(command.text);
        } else {
          await page.keyboard.insertText(command.text);
        }
        return ok({ _tag: "VoidResult" } as const);

      case "keydown":
        await page.keyboard.down(command.key);
        return ok({ _tag: "VoidResult" } as const);

      case "keyup":
        await page.keyboard.up(command.key);
        return ok({ _tag: "VoidResult" } as const);

      case "scrollintoview":
        await page.locator(command.selector).scrollIntoViewIfNeeded();
        return ok({ _tag: "VoidResult" } as const);

      case "drag":
        await page.locator(command.source).dragTo(page.locator(command.target));
        return ok({ _tag: "VoidResult" } as const);

      case "mousemove":
        await page.mouse.move(command.x, command.y);
        return ok({ _tag: "VoidResult" } as const);

      case "mousedown":
        await page.mouse.down({ button: command.button });
        return ok({ _tag: "VoidResult" } as const);

      case "mouseup":
        await page.mouse.up({ button: command.button });
        return ok({ _tag: "VoidResult" } as const);

      case "wheel":
        await page.mouse.wheel(command.deltaX, command.deltaY);
        return ok({ _tag: "VoidResult" } as const);

      case "viewport": {
        await page.setViewportSize({ width: command.width, height: command.height });
        if (command.deviceScaleFactor !== undefined) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: command.width,
            height: command.height,
            deviceScaleFactor: command.deviceScaleFactor,
            mobile: false,
          });
          await cdp.detach();
        }
        return ok({ _tag: "VoidResult" } as const);
      }

      case "geolocation":
        await context.setGeolocation({ latitude: command.latitude, longitude: command.longitude });
        return ok({ _tag: "VoidResult" } as const);

      case "offline":
        await context.setOffline(command.offline);
        return ok({ _tag: "VoidResult" } as const);

      case "headers":
        await page.setExtraHTTPHeaders(command.headers);
        return ok({ _tag: "VoidResult" } as const);

      case "credentials":
        await context.setHTTPCredentials({ username: command.username, password: command.password });
        return ok({ _tag: "VoidResult" } as const);

      case "emulatemedia":
        await page.emulateMedia({
          colorScheme: command.colorScheme,
          reducedMotion: command.reducedMotion,
        });
        return ok({ _tag: "VoidResult" } as const);

      case "storage_get": {
        const storageName = command.type === "local" ? "localStorage" : "sessionStorage";
        if (command.key !== undefined) {
          const value = await page.evaluate(
            ({ name, key }) => window[name as "localStorage" | "sessionStorage"].getItem(key),
            { name: storageName, key: command.key },
          );
          const r: StorageResult = { _tag: "StorageResult", key: command.key, value };
          return ok(r);
        }
        const data = await page.evaluate((name) => {
          const storage = window[name as "localStorage" | "sessionStorage"];
          return Object.fromEntries(
            Array.from({ length: storage.length }, (_, index) => storage.key(index))
              .filter((key): key is string => key !== null)
              .map((key) => [key, storage.getItem(key) ?? ""]),
          );
        }, storageName);
        const r: StorageResult = { _tag: "StorageResult", data };
        return ok(r);
      }

      case "storage_set": {
        const storageName = command.type === "local" ? "localStorage" : "sessionStorage";
        await page.evaluate(
          ({ name, key, value }) => window[name as "localStorage" | "sessionStorage"].setItem(key, value),
          { name: storageName, key: command.key, value: command.value },
        );
        return ok({ _tag: "VoidResult" } as const);
      }

      case "storage_clear": {
        const storageName = command.type === "local" ? "localStorage" : "sessionStorage";
        await page.evaluate((name) => window[name as "localStorage" | "sessionStorage"].clear(), storageName);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "nth": {
        const loc = page.locator(command.selector).nth(command.index);
        if (command.subaction === "click") {
          await loc.click();
        } else if (command.subaction === "fill" && command.value) {
          await loc.fill(command.value);
        } else if (command.subaction === "type" && command.value) {
          await loc.pressSequentially(command.value);
        } else if (command.subaction === "hover") {
          await loc.hover();
        }
        return ok({ _tag: "VoidResult" } as const);
      }

      case "upload":
        await page.locator(command.selector).setInputFiles(command.files as string[]);
        return ok({ _tag: "VoidResult" } as const);

      case "cookies_set":
        await context.addCookies(command.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          ...(cookie.url !== undefined
            ? { url: cookie.url }
            : cookie.domain !== undefined
              ? { domain: cookie.domain, path: cookie.path ?? "/" }
              : { url: page.url() }),
          ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
          ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
        })));
        return ok({ _tag: "VoidResult" } as const);

      case "dialog":
        // Dialog status/accept/dismiss — requires listener setup
        // For now return void; full dialog state tracking is a follow-up
        return ok({ _tag: "VoidResult" } as const);

      case "frame":
        // Frame switching requires tracking active frame context — follow-up
        return ok({ _tag: "VoidResult" } as const);

      case "mainframe":
        return ok({ _tag: "VoidResult" } as const);

      case "console":
        // Console log collection requires listener setup — follow-up
        return ok({ _tag: "VoidResult" } as const);

      case "errors":
        // Error collection requires listener setup — follow-up
        return ok({ _tag: "VoidResult" } as const);

      default:
        return exhaustive(command);
    }
  } catch (e) {
    return err(mapPlaywrightError(e));
  }
}
