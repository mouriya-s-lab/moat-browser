import { chromium, devices } from "patchright";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Frame,
  Locator,
  Page,
  Request,
} from "patchright";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserCommand,
  CommandResultData,
  ControllerError,
  CookieEntry,
  EvalResult,
  LocatorResult,
  LocatorSubaction,
  NavigateResult,
  PushStateResult,
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
  ConsoleResult,
  PageErrorsResult,
  ClearedResult,
  NetworkRequestEntry,
  NetworkRequestsResult,
  NetworkRequestDetailResult,
  BinaryFileResult,
  HarContentMode,
  ClipboardResult,
  DialogResult,
  FrameResult,
  CdpUrlResult,
  TouchResult,
  StateLoadResult,
  StartedResult,
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

const contextCdpUrls = new WeakMap<BrowserContext, string>();



const REMOTE_DOWNLOAD_PATH = "/data/profile/.moat-downloads";

type DownloadWillBegin = {
  readonly frameId: string;
  readonly guid: string;
  readonly suggestedFilename: string;
};

type DownloadProgress = {
  readonly guid: string;
  readonly state: "inProgress" | "completed" | "canceled";
};

function frameIds(frameTree: { readonly frame: { readonly id: string }; readonly childFrames?: readonly unknown[] }): Set<string> {
  const ids = new Set<string>();
  const visit = (tree: typeof frameTree): void => {
    ids.add(tree.frame.id);
    for (const child of tree.childFrames ?? []) visit(child as typeof frameTree);
  };
  visit(frameTree);
  return ids;
}

async function remoteDownload(
  context: BrowserContext,
  page: Page,
  sessionId: string,
  timeout: number | undefined,
  trigger?: () => Promise<void>,
): Promise<BinaryFileResult> {
  const browser = context.browser();
  if (!browser) throw new Error("The CDP browser connection is unavailable");

  const browserCdp = await browser.newBrowserCDPSession();
  const pageCdp = await context.newCDPSession(page);
  const localDownloadPath = join(
    process.env.PROFILES_WORK ?? "/data/profiles",
    `agent-${sessionId}`,
    ".moat-downloads",
  );
  try {
    await mkdir(localDownloadPath, { recursive: true });
    await chmod(localDownloadPath, 0o777);
    const tree = await pageCdp.send("Page.getFrameTree");
    const ownedFrames = frameIds(tree.frameTree);
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: REMOTE_DOWNLOAD_PATH,
      eventsEnabled: true,
    });

    const finished = new Promise<DownloadWillBegin>((resolve, reject) => {
      let begun: DownloadWillBegin | undefined;
      const timer = setTimeout(() => reject(new Error("Timeout waiting for download")), timeout ?? 30_000);
      browserCdp.on("Browser.downloadWillBegin", (event: DownloadWillBegin) => {
        if (!ownedFrames.has(event.frameId) || begun) return;
        begun = event;
      });
      browserCdp.on("Browser.downloadProgress", (event: DownloadProgress) => {
        if (!begun || event.guid !== begun.guid || event.state === "inProgress") return;
        clearTimeout(timer);
        if (event.state === "canceled") reject(new Error("Download was canceled"));
        else resolve(begun);
      });
    });

    if (trigger) await trigger();
    const download = await finished;
    const localFile = join(localDownloadPath, download.guid);
    try {
      const bytes = await readFile(localFile);
      return {
        _tag: "BinaryFileResult",
        base64: bytes.toString("base64"),
        suggestedFilename: download.suggestedFilename,
      };
    } finally {
      await rm(localFile, { force: true });
    }
  } finally {
    await Promise.allSettled([browserCdp.detach(), pageCdp.detach()]);
  }
}

export async function connectCDP(cdpUrl: string): Promise<CdpConnection> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  contextCdpUrls.set(context, cdpUrl);
  return { browser, context };
}

// ─── Tab tracking (per-session) ───

const sessionTabIndex = new Map<string, number>();

type SessionRuntimeState = {
  readonly observedPages: WeakSet<Page>;
  readonly cdpObservedPages: WeakSet<Page>;
  readonly pageObservers: WeakMap<Page, Promise<void>>;
  readonly observerSessions: Set<CDPSession>;
  readonly pendingConsoleKeys: Set<string>;
  readonly pendingErrorMessages: Set<string>;
  readonly consoleMessages: Array<{ readonly type: string; readonly text: string }>;
  readonly pageErrors: Array<{ readonly message: string }>;
  readonly requestIds: WeakMap<Request, string>;
  readonly requests: Map<string, NetworkRequestEntry>;
  readonly responseBodyReads: Map<string, Promise<Buffer | undefined>>;
  readonly responseBodySizes: Map<string, Promise<number | undefined>>;
  activeFrame?: Frame;
  pendingDialog?: Dialog;
  dialogInfo?: {
    readonly type: string;
    readonly message: string;
    readonly defaultPrompt: string;
  };
  traceActive: boolean;
  profilerSession?: CDPSession;
  harActive: boolean;
  harContentMode: HarContentMode;
  nextRequestId: number;
};

const sessionRuntimeState = new Map<string, SessionRuntimeState>();

function getSessionRuntimeState(sessionId: string): SessionRuntimeState {
  const existing = sessionRuntimeState.get(sessionId);
  if (existing) return existing;
  const created: SessionRuntimeState = {
    observedPages: new WeakSet<Page>(),
    cdpObservedPages: new WeakSet<Page>(),
    pageObservers: new WeakMap<Page, Promise<void>>(),
    observerSessions: new Set<CDPSession>(),
    pendingConsoleKeys: new Set<string>(),
    pendingErrorMessages: new Set<string>(),
    consoleMessages: [],
    pageErrors: [],
    requestIds: new WeakMap<Request, string>(),
    requests: new Map<string, NetworkRequestEntry>(),
    responseBodyReads: new Map<string, Promise<Buffer | undefined>>(),
    responseBodySizes: new Map<string, Promise<number | undefined>>(),
    traceActive: false,
    harActive: false,
    harContentMode: "text",
    nextRequestId: 1,
  };
  sessionRuntimeState.set(sessionId, created);
  return created;
}

function recordConsole(
  state: SessionRuntimeState,
  type: string,
  text: string,
): void {
  const key = `${type}\0${text}`;
  if (state.pendingConsoleKeys.has(key)) return;
  state.pendingConsoleKeys.add(key);
  queueMicrotask(() => state.pendingConsoleKeys.delete(key));
  state.consoleMessages.push({ type, text });
}

function recordPageError(state: SessionRuntimeState, message: string): void {
  if (state.pendingErrorMessages.has(message)) return;
  state.pendingErrorMessages.add(message);
  queueMicrotask(() => state.pendingErrorMessages.delete(message));
  state.pageErrors.push({ message });
}

function responseHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function harMimeIsText(mimeType: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/")
    || mime.endsWith("+json")
    || mime.endsWith("+xml")
    || mime === "application/json"
    || mime === "application/xml"
    || mime === "application/javascript"
    || mime === "application/x-javascript"
    || mime === "application/ecmascript"
    || mime === "application/x-www-form-urlencoded"
    || mime === "application/graphql";
}

function observePageRuntime(sessionId: string, page: Page): SessionRuntimeState {
  const state = getSessionRuntimeState(sessionId);
  if (state.observedPages.has(page)) return state;
  state.observedPages.add(page);
  page.on("console", (message) => {
    if (!state.cdpObservedPages.has(page)) recordConsole(state, message.type(), message.text());
  });
  page.on("pageerror", (error) => {
    if (!state.cdpObservedPages.has(page)) recordPageError(state, error.message);
  });
  page.on("dialog", (dialog) => {
    state.pendingDialog = dialog;
    state.dialogInfo = {
      type: dialog.type(),
      message: dialog.message(),
      defaultPrompt: dialog.defaultValue(),
    };
  });
  page.on("request", (request) => {
    const requestId = String(state.nextRequestId++);
    state.requestIds.set(request, requestId);
    const postData = request.postData();
    state.requests.set(requestId, {
      requestId,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: request.headers(),
      ...(postData !== null ? { postData } : {}),
    });
  });
  page.on("response", (response) => {
    const requestId = state.requestIds.get(response.request());
    if (!requestId) return;
    const current = state.requests.get(requestId);
    if (!current) return;
    const responseHeaders = response.headers();
    state.requests.set(requestId, {
      ...current,
      status: response.status(),
      responseHeaders,
    });
    const bodyRead = response.body().then((bytes) => {
      const latest = state.requests.get(requestId);
      if (latest) {
        state.requests.set(requestId, {
          ...latest,
          responseBody: bytes.toString("utf8"),
        });
      }
      return bytes;
    }).catch(() => undefined);
    if (state.harActive) {
      state.responseBodySizes.set(requestId, bodyRead.then((bytes) => bytes?.byteLength));
      const captureHarBody = state.harContentMode === "all"
        || (state.harContentMode === "text"
          && harMimeIsText(responseHeader(responseHeaders, "content-type") ?? ""));
      if (captureHarBody) state.responseBodyReads.set(requestId, bodyRead);
    }
  });
  return state;
}

async function ensureCdpRuntimeObserver(
  sessionId: string,
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const state = getSessionRuntimeState(sessionId);
  const existingObserver = state.pageObservers.get(page);
  if (existingObserver) {
    await existingObserver;
    return;
  }
  const observer = (async () => {
    const cdp = await context.newCDPSession(page);
    state.observerSessions.add(cdp);
    state.cdpObservedPages.add(page);
    cdp.on("Runtime.consoleAPICalled", (event) => {
      const text = event.args.map((arg) => {
        if (arg.value !== undefined) return String(arg.value);
        return arg.description ?? arg.type;
      }).join(" ");
      recordConsole(state, event.type, text);
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      recordPageError(state, event.exceptionDetails.exception?.description
        ?? event.exceptionDetails.text);
    });
    await cdp.send("Runtime.enable");
  })();
  state.pageObservers.set(page, observer);
  try {
    await observer;
  } catch (error) {
    state.pageObservers.delete(page);
    throw error;
  }
}

export function clearSessionRuntimeState(sessionId: string): void {
  const state = sessionRuntimeState.get(sessionId);
  if (state) {
    for (const cdp of state.observerSessions) void cdp.detach().catch(() => {});
  }
  sessionRuntimeState.delete(sessionId);
  sessionTabIndex.delete(sessionId);
}

function statusMatches(actual: number | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  if (/^\dxx$/.test(expected)) return Math.floor(actual / 100) === Number(expected[0]);
  const range = /^(\d{3})-(\d{3})$/.exec(expected);
  if (range) return actual >= Number(range[1]) && actual <= Number(range[2]);
  return actual === Number(expected);
}

async function readCdpStream(cdp: CDPSession, handle: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let eof = false;
  while (!eof) {
    const chunk = await cdp.send("IO.read", { handle });
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
    eof = chunk.eof === true;
  }
  await cdp.send("IO.close", { handle });
  return Buffer.concat(chunks);
}

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
      if (value === undefined) {
        return err({
          _tag: "ValidationFailed",
          message: "Missing 'value' for fill subaction",
        } as const);
      }
      await locator.fill(value);
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      if (value === undefined) {
        return err({
          _tag: "ValidationFailed",
          message: "Missing 'value' for type subaction",
        } as const);
      }
      await locator.pressSequentially(value);
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

    case "text": {
      const innerText = await locator.innerText();
      const textContent = innerText === "" ? await locator.textContent() : null;
      const result: GetTextResult = {
        _tag: "GetTextResult",
        text: innerText !== "" ? innerText : (textContent ?? ""),
      };
      return ok(result);
    }

    default:
      return exhaustive(subaction);
  }
}

// ─── resolveLocator ───

function resolveLocator(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  ref?: string,
  selector?: string,
): Locator | null {
  if (ref) return refStore.resolve(sessionId, ref) ?? null;
  if (selector) return scope.locator(selector);
  return null;
}

// ─── executeElementAction ───

async function executeElementAction(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  ref: string | undefined,
  selector: string | undefined,
  action: "click" | "fill" | "type" | "hover",
  value?: string,
  clear?: boolean,
  delay?: number,
): Promise<Result<CommandResultData, ControllerError>> {
  const locator = resolveLocator(scope, refStore, sessionId, ref, selector);
  if (!locator) return err({ _tag: "ElementNotFound", selector: ref ?? selector } as const);

  switch (action) {
    case "click":
      await locator.click();
      return ok({ _tag: "VoidResult" } as const);

    case "fill":
      await locator.fill(value!);
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      if (clear) await locator.fill("");
      if (delay === undefined) {
        await locator.pressSequentially(value!);
      } else {
        await locator.pressSequentially(value!, { delay });
      }
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
const ARIA_URL_LINE_RE = /^\s*- \/url:\s*.*$/;

async function buildAriaSnapshot(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  options: {
    readonly selector?: string;
    readonly ref?: string;
    readonly interactive?: boolean;
    readonly compact?: boolean;
    readonly maxDepth?: number;
    readonly urls?: boolean;
  } = {},
): Promise<string> {
  const root = options.ref
    ? refStore.resolve(sessionId, options.ref)
    : scope.locator(options.selector ?? "body");
  if (!root) throw new Error(`Unknown element ref: ${options.ref}`);

  const snapshot = await root.ariaSnapshot();
  const rawLines = snapshot.split("\n");
  const indentations = rawLines.map((line) => line.length - line.trimStart().length);

  const roleOccurrences = new Map<string, number>();
  const roleOccurrenceBySource = new Map<number, number>();
  const namedOccurrences = new Map<string, Map<string, number>>();
  const namedOccurrenceBySource = new Map<number, number>();
  for (const [sourceIndex, line] of rawLines.entries()) {
    const match = ARIA_LINE_RE.exec(line);
    if (!match || !INTERACTIVE_ROLES.has(match[2])) continue;

    const [, , role, name] = match;
    const roleOccurrence = roleOccurrences.get(role) ?? 0;
    roleOccurrences.set(role, roleOccurrence + 1);
    roleOccurrenceBySource.set(sourceIndex, roleOccurrence);

    if (name) {
      const occurrencesByName = namedOccurrences.get(role) ?? new Map<string, number>();
      const namedOccurrence = occurrencesByName.get(name) ?? 0;
      occurrencesByName.set(name, namedOccurrence + 1);
      namedOccurrences.set(role, occurrencesByName);
      namedOccurrenceBySource.set(sourceIndex, namedOccurrence);
    }
  }

  const visibleLines = rawLines
    .map((line, sourceIndex) => ({ line, sourceIndex, indentation: indentations[sourceIndex] }))
    .filter(({ line, indentation }) => {
      if (options.maxDepth !== undefined && Math.floor(indentation / 2) > options.maxDepth) {
        return false;
      }
      if (!options.interactive) return true;
      const match = ARIA_LINE_RE.exec(line);
      return match !== null && INTERACTIVE_ROLES.has(match[2]);
    });

  type RenderedSnapshotLine = {
    readonly sourceIndex: number;
    readonly line: string;
    readonly role?: string;
    readonly locator?: Locator;
  };

  const refs = new Map<string, Locator>();
  let counter = 1;
  const getRoleLocator = (
    role: Parameters<Page["getByRole"]>[0],
    name?: string,
  ): Locator => {
    const options = name === undefined ? undefined : { name, exact: true };
    const descendants = root.getByRole(role, options);
    const rootMatch = root.and(scope.getByRole(role, options));
    return rootMatch.or(descendants);
  };

  const renderedLines: Array<RenderedSnapshotLine> = visibleLines.map(({ line, sourceIndex }) => {
    const m = ARIA_LINE_RE.exec(line);
    if (!m) return { sourceIndex, line };

    const [, indent, role, name, rest] = m;
    if (!INTERACTIVE_ROLES.has(role)) return { sourceIndex, line };

    const key = `@e${counter}`;
    const occurrence = name
      ? namedOccurrenceBySource.get(sourceIndex)
      : roleOccurrenceBySource.get(sourceIndex);
    if (occurrence === undefined) {
      throw new Error(`Cannot map ARIA ${role} at snapshot line ${sourceIndex}`);
    }
    const locator = getRoleLocator(
      role as Parameters<Page["getByRole"]>[0],
      name || undefined,
    ).nth(occurrence);
    refs.set(key, locator);
    counter++;

    return {
      sourceIndex,
      line: name
        ? `${indent}${key} ${role} "${name}"${rest}`
        : `${indent}${key} ${role}${rest}`,
      role,
      locator,
    };
  });

  if (!options.urls) {
    refStore.update(sessionId, refs);
    return renderedLines
      .filter((entry) => !options.compact || entry.line.trim().length > 0)
      .map((entry) => entry.line)
      .join("\n");
  }

  // URL enrichment is opt-in. Keep the normal snapshot path above free of
  // parent maps and reverse scans; URL relationships are derived linearly only
  // when the caller requests resolved links.
  const urlChildrenByLink = new Map<number, Array<number>>();
  const rawParentStack: Array<{ readonly indentation: number; readonly sourceIndex: number }> = [];
  for (let sourceIndex = 0; sourceIndex < rawLines.length; sourceIndex++) {
    const indentation = indentations[sourceIndex];
    while (
      rawParentStack.length > 0
      && rawParentStack[rawParentStack.length - 1].indentation >= indentation
    ) {
      rawParentStack.pop();
    }
    const parentIndex = rawParentStack.at(-1)?.sourceIndex;
    if (parentIndex !== undefined && ARIA_URL_LINE_RE.test(rawLines[sourceIndex])) {
      const parentMatch = ARIA_LINE_RE.exec(rawLines[parentIndex]);
      if (parentMatch?.[2] === "link") {
        const children = urlChildrenByLink.get(parentIndex) ?? [];
        children.push(sourceIndex);
        urlChildrenByLink.set(parentIndex, children);
      }
    }
    rawParentStack.push({ indentation, sourceIndex });
  }

  const visibleParentBySource = new Map<number, number>();
  const visibleParentStack: Array<{ readonly indentation: number; readonly sourceIndex: number }> = [];
  for (const child of visibleLines) {
    while (
      visibleParentStack.length > 0
      && visibleParentStack[visibleParentStack.length - 1].indentation >= child.indentation
    ) {
      visibleParentStack.pop();
    }
    const parent = visibleParentStack.at(-1);
    if (parent) visibleParentBySource.set(child.sourceIndex, parent.sourceIndex);
    visibleParentStack.push(child);
  }

  const linkUrls = new Map<number, string>();
  await Promise.all(
    renderedLines.map(async (entry) => {
      if (entry.role !== "link" || !entry.locator) return;
      const url = await entry.locator.evaluate((element) => {
        if (element instanceof HTMLAnchorElement) return element.href;
        return "";
      });
      if (url) linkUrls.set(entry.sourceIndex, url);
    }),
  );

  const removedUrlSources = new Set<number>();
  for (const sourceIndex of linkUrls.keys()) {
    for (const childSourceIndex of urlChildrenByLink.get(sourceIndex) ?? []) {
      removedUrlSources.add(childSourceIndex);
    }
  }

  const renderedChildParents = new Set<number>();
  for (const [childSourceIndex, parentSourceIndex] of visibleParentBySource) {
    if (!removedUrlSources.has(childSourceIndex)) {
      renderedChildParents.add(parentSourceIndex);
    }
  }

  const withUrl = (line: string, url: string, hasChildren: boolean): string => {
    if (line.includes("[url=")) return line;
    const colon = /:\s*$/.exec(line);
    const base = colon ? line.slice(0, colon.index) : line;
    const suffix = colon && hasChildren ? colon[0] : "";
    return `${base} [url=${url}]${suffix}`;
  };

  const annotated = renderedLines
    .filter((entry) => !removedUrlSources.has(entry.sourceIndex))
    .map((entry) => {
      const url = linkUrls.get(entry.sourceIndex);
      if (!url) return entry.line;
      return withUrl(
        entry.line,
        url,
        renderedChildParents.has(entry.sourceIndex),
      );
    })
    .filter((line) => !options.compact || line.trim().length > 0)
    .join("\n");

  refStore.update(sessionId, refs);
  return annotated;
}

type ScreenshotAnnotation = {
  readonly number: number;
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

async function installScreenshotAnnotations(
  page: Page,
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
): Promise<ReadonlyArray<ScreenshotAnnotation>> {
  await buildAriaSnapshot(scope, refStore, sessionId, { interactive: true });
  const annotations: Array<ScreenshotAnnotation> = [];
  for (const [ref, locator] of refStore.entries(sessionId)) {
    const box = await locator.boundingBox();
    if (!box) continue;
    annotations.push({
      number: Number.parseInt(ref.replace(/^@e/, ""), 10),
      ref,
      role: "",
      name: "",
      ...box,
    });
  }
  await page.evaluate((items) => {
    for (const item of items) {
      const outline = document.createElement("div");
      outline.dataset.moatScreenshotAnnotation = "true";
      Object.assign(outline.style, {
        position: "absolute",
        left: `${item.x + window.scrollX}px`,
        top: `${item.y + window.scrollY}px`,
        width: `${item.width}px`,
        height: `${item.height}px`,
        border: "2px solid #ff1744",
        boxSizing: "border-box",
        zIndex: "2147483646",
        pointerEvents: "none",
      });
      const label = document.createElement("span");
      label.textContent = String(item.number);
      Object.assign(label.style, {
        position: "absolute",
        left: "-2px",
        top: "-20px",
        color: "white",
        background: "#ff1744",
        padding: "1px 5px",
        font: "bold 12px sans-serif",
      });
      outline.append(label);
      document.body.append(outline);
    }
  }, annotations);
  return annotations;
}

async function removeScreenshotAnnotations(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-moat-screenshot-annotation="true"]').forEach((element) => element.remove());
  });
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
  const runtimeState = observePageRuntime(sessionId, page);
  if (command.action === "eval") await ensureCdpRuntimeObserver(sessionId, context, page);
  const scope = runtimeState.activeFrame ?? page;

  try {
    switch (command.action) {
      case "navigate": {
        runtimeState.activeFrame = undefined;
        if (command.headers) await page.setExtraHTTPHeaders(command.headers);
        await page.goto(command.url, {
          waitUntil: command.waitUntil === "none" ? "commit" : (command.waitUntil ?? "domcontentloaded"),
        });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }
      case "pushstate": {
        runtimeState.activeFrame = undefined;
        // Patchright defaults evaluate() to its isolated utility world.  The
        // page-owned Next router only exists in the main world, so this
        // explicit `false` is required without changing the global eval path.
        const expression = `((url) => {
          const before = location.href;
          const absolute = new URL(url, before).href;
          if (absolute === before) return before;

          const router = typeof window.next === "object" && window.next && window.next.router;
          if (router && typeof router.push === "function") {
            try {
              router.push(url);
              return location.href;
            } catch {}
          }

          history.pushState(null, "", absolute);
          try { dispatchEvent(new PopStateEvent("popstate", { state: null })); } catch {}
          try { dispatchEvent(new Event("navigate")); } catch {}
          return location.href;
        })(${JSON.stringify(command.url)})`;
        const resultingUrl = await page.evaluate<string>(expression, undefined, false);
        const result: PushStateResult = { _tag: "PushStateResult", url: resultingUrl };
        return ok(result);
      }



      case "back": {
        runtimeState.activeFrame = undefined;
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
        runtimeState.activeFrame = undefined;
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
        runtimeState.activeFrame = undefined;
        await page.reload({ waitUntil: "domcontentloaded" });
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "getbyrole": {
        let loc = scope.getByRole(command.role as Parameters<Page["getByRole"]>[0], {
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
          scope.getByLabel(command.label, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbyplaceholder":
        return executeLocatorAction(
          scope.getByPlaceholder(command.placeholder, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbytext":
        return executeLocatorAction(
          scope.getByText(command.text, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbyalttext":
        return executeLocatorAction(
          scope.getByAltText(command.text, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbytitle":
        return executeLocatorAction(
          scope.getByTitle(command.text, { exact: command.exact }),
          command.subaction, command.value,
        );

      case "getbytestid":
        return executeLocatorAction(
          scope.getByTestId(command.testId),
          command.subaction, command.value,
        );

      case "click":
        return executeElementAction(scope, refStore, sessionId, command.ref, command.selector, "click");

      case "fill":
        return executeElementAction(scope, refStore, sessionId, command.ref, command.selector, "fill", command.value);

      case "type":
        return executeElementAction(
          scope, refStore, sessionId, command.ref, command.selector, "type",
          command.text, command.clear, command.delay,
        );

      case "hover":
        return executeElementAction(scope, refStore, sessionId, command.ref, command.selector, "hover");

      case "snapshot": {
        const snapshot = await buildAriaSnapshot(scope, refStore, sessionId, command);
        const result: SnapshotResult = { _tag: "SnapshotResult", snapshot };
        return ok(result);
      }

      case "screenshot": {
        const format = command.format ?? "png";
        const screenshotOptions = {
          type: format,
          quality: format === "jpeg" ? (command.quality ?? 80) : undefined,
        } as const;
        const target = command.ref
          ? refStore.resolve(sessionId, command.ref)
          : command.selector
            ? scope.locator(command.selector)
            : undefined;
        if (command.ref && !target) return err({ _tag: "ElementNotFound", selector: command.ref });
        const annotations = command.annotate
          ? await installScreenshotAnnotations(page, scope, refStore, sessionId)
          : [];
        let buf: Buffer;
        try {
          buf = target
            ? await target.screenshot(screenshotOptions)
            : await page.screenshot({ ...screenshotOptions, fullPage: command.fullPage ?? false });
        } finally {
          if (command.annotate) await removeScreenshotAnnotations(page);
        }
        const result: ScreenshotResult = {
          _tag: "ScreenshotResult",
          base64: buf.toString("base64"),
          format,
          annotations: annotations.map(({ number, ref, role, name }) => ({ number, ref, role, name })),
        };
        return ok(result);
      }

      case "eval": {
        const raw = await scope.evaluate(command.code);
        const result: EvalResult = { _tag: "EvalResult", result: JSON.stringify(raw) };
        return ok(result);
      }

      case "press":
        await page.keyboard.press(command.key);
        return ok({ _tag: "VoidResult" } as const);

      case "scroll":
        await scope.evaluate(({ dir, amt }) => {
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
        runtimeState.activeFrame = undefined;
        observePageRuntime(sessionId, newPage);
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_switch": {
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= context.pages().length) {
          return err({ _tag: "CommandFailed", message: `Unknown tab index: ${command.index}` });
        }
        activeTabIndex = command.index;
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activeFrame = undefined;
        observePageRuntime(sessionId, context.pages()[activeTabIndex]);
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_close": {
        const closeIndex = command.index ?? activeTabIndex;
        if (!Number.isInteger(closeIndex) || closeIndex < 0 || closeIndex >= context.pages().length) {
          return err({ _tag: "CommandFailed", message: `Unknown tab index: ${closeIndex}` });
        }
        const closingPage = context.pages()[closeIndex];
        await closingPage.close();
        if (activeTabIndex >= context.pages().length) {
          activeTabIndex = Math.max(0, context.pages().length - 1);
        }
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activeFrame = undefined;
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
          await scope.locator(command.selector).waitFor({ state, timeout: command.timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "selector" };
          return ok(wr);
        }
        if (command.text) {
          await scope.getByText(command.text).waitFor({ timeout: command.timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "text" };
          return ok(wr);
        }
        await new Promise<void>((r) => setTimeout(r, command.time ?? 1000));
        const wr: WaitResult = { _tag: "WaitResult", waited: "timeout" };
        return ok(wr);
      }

      case "waitforurl": {
        await scope.waitForURL(command.url, { timeout: command.timeout });
        const wr: WaitResult = { _tag: "WaitResult", waited: "url", url: page.url() };
        return ok(wr);
      }

      case "waitforloadstate": {
        const state = command.state as "load" | "domcontentloaded" | "networkidle";
        await scope.waitForLoadState(state, { timeout: command.timeout });
        const wr: WaitResult = { _tag: "WaitResult", waited: "loadstate", state: command.state };
        return ok(wr);
      }

      case "waitforfunction": {
        const handle = await scope.waitForFunction(command.expression, undefined, { timeout: command.timeout });
        const val = await handle.jsonValue();
        const wr: WaitResult = { _tag: "WaitResult", waited: "function", result: JSON.stringify(val) };
        return ok(wr);
      }

      // ─── Get (element property queries) ───

      case "gettext": {
        const text = await scope.locator(command.selector).textContent() ?? "";
        const r: GetTextResult = { _tag: "GetTextResult", text };
        return ok(r);
      }

      case "innertext": {
        const text = await scope.locator(command.selector).innerText();
        const r: GetTextResult = { _tag: "GetTextResult", text };
        return ok(r);
      }

      case "innerhtml": {
        const html = await scope.locator(command.selector).innerHTML();
        const r: GetHtmlResult = { _tag: "GetHtmlResult", html };
        return ok(r);
      }

      case "inputvalue": {
        const value = await scope.locator(command.selector).inputValue();
        const r: GetValueResult = { _tag: "GetValueResult", value };
        return ok(r);
      }

      case "getattribute": {
        const value = await scope.locator(command.selector).getAttribute(command.attribute) ?? "";
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
        const r: CountResult = { _tag: "CountResult", count: await scope.locator(command.selector).count() };
        return ok(r);
      }

      case "boundingbox": {
        const r: BoundingBoxResult = {
          _tag: "BoundingBoxResult",
          box: await scope.locator(command.selector).boundingBox(),
        };
        return ok(r);
      }

      case "styles": {
        const elements = await scope.locator(command.selector).evaluateAll((nodes) =>
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
        const visible = await scope.locator(command.selector).isVisible();
        const r: BooleanResult = { _tag: "BooleanResult", visible };
        return ok(r);
      }

      case "isenabled": {
        const enabled = await scope.locator(command.selector).isEnabled();
        const r: BooleanResult = { _tag: "BooleanResult", enabled };
        return ok(r);
      }

      case "ischecked": {
        const checked = await scope.locator(command.selector).isChecked();
        const r: BooleanResult = { _tag: "BooleanResult", checked };
        return ok(r);
      }

      // ─── evaluate alias ───

      case "evaluate": {
        const raw = await scope.evaluate(command.script);
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
        await scope.locator(command.selector).dblclick();
        return ok({ _tag: "VoidResult" } as const);

      case "check":
        await scope.locator(command.selector).check();
        return ok({ _tag: "VoidResult" } as const);

      case "uncheck":
        await scope.locator(command.selector).uncheck();
        return ok({ _tag: "VoidResult" } as const);

      case "select": {
        const values = Array.isArray(command.values) ? command.values : [command.values];
        await scope.locator(command.selector).selectOption(values);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "focus":
        await scope.locator(command.selector).focus();
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
        await scope.locator(command.selector).scrollIntoViewIfNeeded();
        return ok({ _tag: "VoidResult" } as const);

      case "drag":
        await scope.locator(command.source).dragTo(scope.locator(command.target));
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

      case "device": {
        const descriptor = devices[command.device];
        if (!descriptor) {
          return err({ _tag: "CommandFailed", message: `Unknown device: ${command.device}` });
        }
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: descriptor.viewport.width,
          height: descriptor.viewport.height,
          deviceScaleFactor: descriptor.deviceScaleFactor,
          mobile: descriptor.isMobile,
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: descriptor.hasTouch,
        });
        await cdp.send("Network.setUserAgentOverride", {
          userAgent: descriptor.userAgent,
        });
        await cdp.detach();
        await page.setViewportSize(descriptor.viewport);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "geolocation":
        await context.grantPermissions(["geolocation"]);
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
          const value = await scope.evaluate(
            ({ name, key }) => window[name as "localStorage" | "sessionStorage"].getItem(key),
            { name: storageName, key: command.key },
          );
          const r: StorageResult = { _tag: "StorageResult", key: command.key, value };
          return ok(r);
        }
        const data = await scope.evaluate((name) => {
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
        await scope.evaluate(
          ({ name, key, value }) => window[name as "localStorage" | "sessionStorage"].setItem(key, value),
          { name: storageName, key: command.key, value: command.value },
        );
        return ok({ _tag: "VoidResult" } as const);
      }

      case "storage_clear": {
        const storageName = command.type === "local" ? "localStorage" : "sessionStorage";
        await scope.evaluate((name) => window[name as "localStorage" | "sessionStorage"].clear(), storageName);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "route": {
        const resourceTypes = (command.resourceType ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0);
        await page.route(command.url, async (route) => {
          const requestResourceType = route.request().resourceType().toLowerCase();
          if (resourceTypes.length > 0 && !resourceTypes.includes(requestResourceType)) {
            await route.continue();
            return;
          }
          if (command.abort) {
            await route.abort();
          } else if (command.body !== undefined) {
            await route.fulfill({ body: command.body, contentType: "application/json" });
          } else {
            await route.continue();
          }
        });
        return ok({ _tag: "VoidResult" } as const);
      }

      case "unroute":
        if (command.url !== undefined) {
          await page.unroute(command.url);
        } else {
          await page.unrouteAll({ behavior: "wait" });
        }
        return ok({ _tag: "VoidResult" } as const);

      case "requests": {
        if (command.clear) {
          runtimeState.requests.clear();
          const r: ClearedResult = { _tag: "ClearedResult", cleared: true };
          return ok(r);
        }
        const types = command.type?.split(",").map((value) => value.trim());
        const requests = [...runtimeState.requests.values()].filter((request) =>
          (command.filter === undefined || request.url.includes(command.filter))
          && (types === undefined || types.includes(request.resourceType))
          && (command.method === undefined || request.method === command.method.toUpperCase())
          && (command.status === undefined || statusMatches(request.status, command.status)),
        );
        const r: NetworkRequestsResult = { _tag: "NetworkRequestsResult", requests };
        return ok(r);
      }

      case "request_detail": {
        const request = runtimeState.requests.get(command.requestId);
        if (!request) {
          return err({ _tag: "CommandFailed", message: `Unknown request ID: ${command.requestId}` });
        }
        const r: NetworkRequestDetailResult = { _tag: "NetworkRequestDetailResult", request };
        return ok(r);
      }

      case "highlight":
        await scope.locator(command.selector).highlight();
        return ok({ _tag: "VoidResult" } as const);

      case "window_new": {
        const newPage = await context.newPage();
        activeTabIndex = context.pages().indexOf(newPage);
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activeFrame = undefined;
        observePageRuntime(sessionId, newPage);
        const r: TabResult = {
          _tag: "TabResult",
          tabs: await buildTabList(context, activeTabIndex),
        };
        return ok(r);
      }

      case "nth": {
        const loc = scope.locator(command.selector).nth(command.index);
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
        await scope.locator(command.selector).setInputFiles(command.files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.base64, "base64"),
        })));
        return ok({ _tag: "VoidResult" } as const);

      case "download": {
        const locator = resolveLocator(scope, refStore, sessionId, command.ref, command.selector);
        if (!locator) return err({ _tag: "ElementNotFound", selector: command.ref ?? command.selector });
        return ok(await remoteDownload(context, page, sessionId, undefined, () => locator.click()));
      }

      case "waitfordownload": {
        return ok(await remoteDownload(context, page, sessionId, command.timeout));
      }

      case "pdf": {
        const bytes = await page.pdf();
        const r: BinaryFileResult = {
          _tag: "BinaryFileResult",
          base64: bytes.toString("base64"),
          suggestedFilename: "page.pdf",
        };
        return ok(r);
      }

      case "clipboard": {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        if (command.operation === "write") {
          if (command.text === undefined) {
            return err({ _tag: "CommandFailed", message: "clipboard write requires text" });
          }
          await scope.evaluate((text) => navigator.clipboard.writeText(text), command.text);
          const r: ClipboardResult = { _tag: "ClipboardResult", written: command.text };
          return ok(r);
        }
        if (command.operation === "copy") {
          await page.keyboard.press("Control+C");
          const r: ClipboardResult = { _tag: "ClipboardResult", copied: true };
          return ok(r);
        }
        if (command.operation === "paste") {
          await page.keyboard.press("Control+V");
          const r: ClipboardResult = { _tag: "ClipboardResult", pasted: true };
          return ok(r);
        }
        const text = await scope.evaluate(() => navigator.clipboard.readText());
        const r: ClipboardResult = { _tag: "ClipboardResult", text };
        return ok(r);
      }

      case "tap": {
        const box = await scope.locator(command.selector).boundingBox();
        if (!box) return err({ _tag: "ElementNotFound", selector: command.selector });
        const cdp = await context.newCDPSession(page);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
        const r: TouchResult = { _tag: "TouchResult", tapped: command.selector };
        return ok(r);
      }

      case "swipe": {
        const viewport = page.viewportSize() ?? { width: 800, height: 600 };
        const distance = command.distance ?? Math.min(viewport.width, viewport.height) / 2;
        const startX = viewport.width / 2;
        const startY = viewport.height / 2;
        const [deltaX, deltaY] = command.direction === "up" ? [0, -distance]
          : command.direction === "down" ? [0, distance]
            : command.direction === "left" ? [-distance, 0]
              : [distance, 0];
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: startX, y: startY }],
        });
        for (let step = 1; step <= 10; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{
              x: startX + (deltaX * step) / 10,
              y: startY + (deltaY * step) / 10,
            }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
        const r: TouchResult = { _tag: "TouchResult", swiped: command.direction };
        return ok(r);
      }

      case "cdp_url": {
        const cdpUrl = contextCdpUrls.get(context);
        if (!cdpUrl) return err({ _tag: "CdpDisconnected", containerId: "" });
        const r: CdpUrlResult = { _tag: "CdpUrlResult", cdpUrl };
        return ok(r);
      }

      case "inspect":
        return err({
          _tag: "CommandFailed",
          message: "unsupported_in_moat: inspect requires a local DevTools proxy, but moat sessions use private remote CDP",
        });

      case "device_list":
        return err({
          _tag: "CommandFailed",
          message: "unsupported_in_moat: device list requires local Xcode/Appium, which moat-browser does not provide",
        });

      case "state_save": {
        const playwrightState = await context.storageState();
        const sessionStorageByOrigin = new Map<string, ReadonlyArray<{ name: string; value: string }>>();
        for (const statePage of context.pages()) {
          let origin: string;
          try {
            origin = new URL(statePage.url()).origin;
          } catch {
            continue;
          }
          if (origin === "null") continue;
          const entries = await statePage.evaluate(() =>
            Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
              .filter((name): name is string => name !== null)
              .map((name) => ({ name, value: sessionStorage.getItem(name) ?? "" })),
          );
          sessionStorageByOrigin.set(origin, entries);
        }
        const localOrigins = new Map(playwrightState.origins.map((entry) => [entry.origin, entry.localStorage]));
        const origins = [...new Set([...localOrigins.keys(), ...sessionStorageByOrigin.keys()])].map((origin) => ({
          origin,
          localStorage: localOrigins.get(origin) ?? [],
          sessionStorage: sessionStorageByOrigin.get(origin) ?? [],
        }));
        const bytes = Buffer.from(JSON.stringify({ cookies: playwrightState.cookies, origins }));
        const r: BinaryFileResult = {
          _tag: "BinaryFileResult",
          base64: bytes.toString("base64"),
          suggestedFilename: "state.json",
        };
        return ok(r);
      }

      case "state_load": {
        await context.clearCookies();
        await context.addCookies(command.state.cookies);
        const cdp = await context.newCDPSession(page);
        await cdp.send("DOMStorage.enable");
        for (const origin of command.state.origins) {
          for (const [isLocalStorage, entries] of [
            [true, origin.localStorage],
            [false, origin.sessionStorage],
          ] as const) {
            const storageId = { securityOrigin: origin.origin, isLocalStorage };
            await cdp.send("DOMStorage.clear", { storageId });
            for (const entry of entries) {
              await cdp.send("DOMStorage.setDOMStorageItem", {
                storageId,
                key: entry.name,
                value: entry.value,
              });
            }
          }
        }
        await cdp.detach();
        const r: StateLoadResult = {
          _tag: "StateLoadResult",
          loaded: true,
          cookies: command.state.cookies.length,
          origins: command.state.origins.length,
        };
        return ok(r);
      }

      case "trace_start": {
        if (runtimeState.traceActive) {
          return err({ _tag: "CommandFailed", message: "Tracing already active" });
        }
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        runtimeState.traceActive = true;
        const r: StartedResult = { _tag: "StartedResult", started: true };
        return ok(r);
      }

      case "trace_stop": {
        if (!runtimeState.traceActive) {
          return err({ _tag: "CommandFailed", message: "No tracing in progress" });
        }
        const directory = await mkdtemp(join(tmpdir(), "moat-trace-"));
        const path = join(directory, "trace.zip");
        try {
          await context.tracing.stop({ path });
          const bytes = await readFile(path);
          runtimeState.traceActive = false;
          const r: BinaryFileResult = {
            _tag: "BinaryFileResult",
            base64: bytes.toString("base64"),
            suggestedFilename: "trace.zip",
          };
          return ok(r);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }

      case "profiler_start": {
        if (runtimeState.profilerSession) {
          return err({ _tag: "CommandFailed", message: "Profiling already active" });
        }
        const cdp = await context.newCDPSession(page);
        await cdp.send("Tracing.start", {
          traceConfig: {
            includedCategories: command.categories ? [...command.categories] : [
              "devtools.timeline",
              "v8.execute",
              "blink.user_timing",
              "disabled-by-default-v8.cpu_profiler",
            ],
            enableSampling: true,
          },
          transferMode: "ReturnAsStream",
        });
        runtimeState.profilerSession = cdp;
        const r: StartedResult = { _tag: "StartedResult", started: true };
        return ok(r);
      }

      case "profiler_stop": {
        const cdp = runtimeState.profilerSession;
        if (!cdp) return err({ _tag: "CommandFailed", message: "No profiling in progress" });
        const completed = new Promise<{ stream?: string }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Profiler stop timed out after 30s")), 30_000);
          cdp.once("Tracing.tracingComplete", (event) => {
            clearTimeout(timeout);
            resolve(event);
          });
        });
        await cdp.send("Tracing.end");
        const { stream } = await completed;
        if (!stream) throw new Error("Profiler completed without a trace stream");
        const bytes = await readCdpStream(cdp, stream);
        await cdp.detach();
        runtimeState.profilerSession = undefined;
        let eventCount = 0;
        try {
          const parsed = JSON.parse(bytes.toString());
          eventCount = Array.isArray(parsed.traceEvents) ? parsed.traceEvents.length : 0;
        } catch {
          eventCount = 0;
        }
        const r: BinaryFileResult = {
          _tag: "BinaryFileResult",
          base64: bytes.toString("base64"),
          suggestedFilename: "profile.json",
          eventCount,
        };
        return ok(r);
      }

      case "har_start": {
        if (runtimeState.harActive) {
          return err({ _tag: "CommandFailed", message: "HAR recording already active" });
        }
        runtimeState.requests.clear();
        runtimeState.responseBodyReads.clear();
        runtimeState.responseBodySizes.clear();
        runtimeState.harContentMode = command.content ?? "text";
        runtimeState.harActive = true;
        const r: StartedResult = { _tag: "StartedResult", started: true };
        return ok(r);
      }

      case "har_stop": {
        if (!runtimeState.harActive) {
          return err({ _tag: "CommandFailed", message: "No HAR recording in progress" });
        }
        runtimeState.harActive = false;
        const contentMode = runtimeState.harContentMode;
        const pendingBodySizes = [...runtimeState.responseBodySizes.entries()];
        const responseBodySizes = new Map<string, number>();
        for (const [requestId, bodySize] of pendingBodySizes) {
          const size = await bodySize;
          if (size !== undefined) responseBodySizes.set(requestId, size);
        }
        runtimeState.responseBodySizes.clear();
        const pendingBodyReads = [...runtimeState.responseBodyReads.entries()];
        const responseBodies = new Map<string, Buffer>();
        for (const [requestId, bodyRead] of pendingBodyReads) {
          const body = await bodyRead;
          if (body !== undefined) responseBodies.set(requestId, body);
        }
        runtimeState.responseBodyReads.clear();

        const entries = [...runtimeState.requests.values()].map((request) => {
          const mimeType = responseHeader(request.responseHeaders, "content-type") ?? "";
          const body = responseBodies.get(request.requestId);
          const contentLength = Number.parseInt(
            responseHeader(request.responseHeaders, "content-length") ?? "",
            10,
          );
          const bodySize = body?.byteLength
            ?? responseBodySizes.get(request.requestId)
            ?? (Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0);
          const content = body === undefined
            || !(contentMode === "all" || (contentMode === "text" && harMimeIsText(mimeType)))
            ? { size: bodySize, mimeType }
            : contentMode === "all" && !harMimeIsText(mimeType)
              ? { size: bodySize, mimeType, text: body.toString("base64"), encoding: "base64" as const }
              : { size: bodySize, mimeType, text: body.toString("utf8") };
          return {
            startedDateTime: new Date().toISOString(),
            time: 0,
            request: {
              method: request.method,
              url: request.url,
              httpVersion: "HTTP/1.1",
              headers: Object.entries(request.requestHeaders).map(([name, value]) => ({ name, value })),
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: request.postData?.length ?? 0,
              ...(request.postData === undefined ? {} : { postData: { mimeType: "", text: request.postData } }),
            },
            response: {
              status: request.status ?? 0,
              statusText: "",
              httpVersion: "HTTP/1.1",
              headers: Object.entries(request.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
              cookies: [],
              content,
              redirectURL: "",
              headersSize: -1,
              bodySize,
            },
            cache: {},
            timings: { send: 0, wait: 0, receive: 0 },
          };
        });
        const bytes = Buffer.from(JSON.stringify({
          log: {
            version: "1.2",
            creator: { name: "moat-browser", version: "0.1.0" },
            entries,
          },
        }, null, 2));
        const r: BinaryFileResult = {
          _tag: "BinaryFileResult",
          base64: bytes.toString("base64"),
          suggestedFilename: "network.har",
          requestCount: entries.length,
        };
        return ok(r);
      }

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

      case "dialog": {
        if (command.response === "status") {
          const info = runtimeState.dialogInfo;
          const r: DialogResult = info === undefined
            ? { _tag: "DialogResult", hasDialog: false }
            : {
                _tag: "DialogResult",
                hasDialog: true,
                type: info.type,
                message: info.message,
                ...(info.defaultPrompt ? { defaultPrompt: info.defaultPrompt } : {}),
              };
          return ok(r);
        }
        // A page cannot synchronously open a JavaScript dialog and return from
        // evaluate: the page is blocked until the dialog is handled.  CLI
        // callers therefore commonly schedule the dialog (for example with
        // setTimeout) immediately before issuing `dialog accept`.  Waiting for
        // the next event here closes that unavoidable race instead of returning
        // "No dialog" and leaving a modal behind to block every later command.
        const dialog = runtimeState.pendingDialog ?? await page.waitForEvent("dialog", { timeout: 5_000 });
        const accepted = command.response === "accept";
        if (accepted) await dialog.accept(command.promptText);
        else await dialog.dismiss();
        runtimeState.pendingDialog = undefined;
        runtimeState.dialogInfo = undefined;
        const r: DialogResult = { _tag: "DialogResult", handled: true, accepted };
        return ok(r);
      }

      case "frame": {
        const handle = await scope.locator(command.selector).elementHandle();
        if (!handle) return err({ _tag: "ElementNotFound", selector: command.selector });
        const frame = await handle.contentFrame();
        if (!frame) {
          return err({ _tag: "CommandFailed", message: `Selector is not a frame: ${command.selector}` });
        }
        runtimeState.activeFrame = frame;
        const r: FrameResult = { _tag: "FrameResult", frame: command.selector };
        return ok(r);
      }

      case "mainframe": {
        runtimeState.activeFrame = undefined;
        const r: FrameResult = { _tag: "FrameResult", frame: "main" };
        return ok(r);
      }

      case "console": {
        if (command.clear) {
          runtimeState.consoleMessages.splice(0);
          const r: ClearedResult = { _tag: "ClearedResult", cleared: true };
          return ok(r);
        }
        const r: ConsoleResult = {
          _tag: "ConsoleResult",
          messages: [...runtimeState.consoleMessages],
        };
        return ok(r);
      }

      case "errors": {
        if (command.clear) {
          runtimeState.pageErrors.splice(0);
          const r: ClearedResult = { _tag: "ClearedResult", cleared: true };
          return ok(r);
        }
        const r: PageErrorsResult = {
          _tag: "PageErrorsResult",
          errors: [...runtimeState.pageErrors],
        };
        return ok(r);
      }

      default:
        return exhaustive(command);
    }
  } catch (e) {
    return err(mapPlaywrightError(e));
  }
}
