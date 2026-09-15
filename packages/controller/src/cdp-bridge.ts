import { chromium, devices } from "patchright";
import type { Browser, BrowserContext, CDPSession, Dialog, Frame, Locator, Page, Request } from "patchright";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserCommand,
  CommandResultData,
  ControllerError,
  CookieEntry,
  KeyStateResult,
  DeviceDescriptor,
  DeviceListResult,
  EvalResult,
  LocatorResult,
  NavigateResult,
  NthSubaction,
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
  ConsoleDiagnostic,
  PageErrorDiagnostic,
  ResourceFailureDiagnostic,
  PolicyBlockedDiagnostic,
  DiagnosticContext,
  DiagnosticRecord,
  ConsoleResult,
  PageErrorsResult,
  ClearedResult,
  NetworkRequestEntry,
  NetworkRequestsResult,
  NetworkRequestDetailResult,
  BinaryFileResult,
  ClipboardResult,
  DialogResult,
  DialogOperation,
  DialogPage,
  DialogType,
  FrameResult,
  CdpUrlResult,
  TouchResult,
  StateLoadResult,
  BrowserStorageState,
  IndexedDbDatabase,
  StateLoadCounts,
  StartedResult,
  BooleanResult,
  BatchResult,
  BatchResultEntry,
  SessionEmulation,
  SessionEnvironmentSettings,
  UserAgentMetadata,
  ViewportOverride,
} from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";
import type {
  RefScope,
  RefStaleReason,
  RefStore,
} from "./ref-store.js";
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

export type CommandExecutionOptions = {
  readonly deadline: number;
  readonly budget: number;
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

type CdpFrameIdentity = {
  readonly frameId: string;
  readonly frameUrl: string;
};

type RecentConsoleFrame = CdpFrameIdentity & {
  readonly timestamp: number;
};

type CdpRequestIdentity = {
  readonly url: string;
  readonly frameId?: string;
  readonly resourceType?: string;
};

type CdpConsoleArg = {
  readonly type: string;
  readonly value?: unknown;
  readonly description?: string;
};

type CdpConsoleEvent = {
  readonly type: string;
  readonly args: ReadonlyArray<CdpConsoleArg>;
  readonly executionContextId?: number;
};

type CdpExceptionEvent = {
  readonly exceptionDetails: {
    readonly text: string;
    readonly exception?: { readonly description?: string };
    readonly executionContextId?: number;
    readonly url?: string;
  };
};

type CdpExecutionContextEvent = {
  readonly context: {
    readonly id: number;
    readonly origin?: string;
    readonly auxData?: { readonly frameId?: string };
  };
};

type CdpRequestEvent = {
  readonly requestId: string;
  readonly request: { readonly url: string };
  readonly frameId?: string;
  readonly type?: string;
};

type CdpLoadingFailedEvent = {
  readonly requestId: string;
  readonly errorText?: string;
  readonly blockedReason?: string;
  readonly frameId?: string;
  readonly type?: string;
};

type CdpLogEvent = {
  readonly entry: {
    readonly source?: string;
    readonly text: string;
    readonly url?: string;
    readonly networkRequestId?: string;
  };
};

type CdpFrameNavigatedEvent = {
  readonly frame: {
    readonly id: string;
    readonly url: string;
  };
type DialogInitiator =
  | { readonly _tag: "NoEval" }
  | { readonly _tag: "Eval"; readonly operationId: string };

type DialogRecord = {
  readonly dialogId: string;
  readonly pageId: string;
  readonly page: Page;
  readonly dialog: Dialog;
  readonly type: DialogType;
  readonly message: string;
  readonly defaultPrompt: string;
  readonly initiator: DialogInitiator;
};

type EvalCompletion =
  | { readonly _tag: "Resolved"; readonly result: EvalResult }
  | { readonly _tag: "Rejected"; readonly error: ControllerError };

type EvalOperation =
  | {
      readonly _tag: "Running";
      readonly operationId: string;
      readonly page: Page;
      readonly completion: Promise<EvalCompletion>;
    }
  | {
      readonly _tag: "DialogObserved";
      readonly operationId: string;
      readonly page: Page;
      readonly dialogId: string;
      readonly completion: Promise<EvalCompletion>;
    }
  | {
      readonly _tag: "Pending";
      readonly operationId: string;
      readonly page: Page;
      readonly dialogId: string;
      readonly completion: Promise<EvalCompletion>;
    }
  | {
      readonly _tag: "Settled";
      readonly operationId: string;
      readonly page: Page;
      readonly dialogId: string;
      readonly result: EvalResult;
    }
  | {
      readonly _tag: "Failed";
      readonly operationId: string;
      readonly page: Page;
      readonly dialogId: string;
      readonly error: ControllerError;
    }
  | {
      readonly _tag: "TimedOut";
      readonly operationId: string;
      readonly page: Page;
      readonly dialogId: string;
      readonly operation: string;
    };

type EvalDeadline =
  | { readonly _tag: "NoDeadline" }
  | { readonly _tag: "Deadline"; readonly at: number; readonly budget: number };

type EvalDeadlineTimer =
  | { readonly _tag: "NoTimer" }
  | { readonly _tag: "Timer"; readonly handle: NodeJS.Timeout };

type EvalTimers = {
  readonly grace: NodeJS.Timeout;
  readonly deadline: EvalDeadlineTimer;
};

type SessionRuntimeState = {
  readonly observedPages: WeakSet<Page>;
  readonly observedContexts: WeakSet<BrowserContext>;
  readonly cdpObservedPages: WeakSet<Page>;
  readonly pageObservers: WeakMap<Page, Promise<void>>;
  readonly pageNavigationGenerations: WeakMap<Page, number>;
  readonly environmentPages: WeakSet<Page>;
  readonly environmentPageSessions: WeakMap<Page, CDPSession>;
  readonly environmentSessions: Set<CDPSession>;
  readonly observerSessions: Set<CDPSession>;
  readonly pendingConsoleKeys: Set<string>;
  readonly pendingErrorMessages: Set<string>;
  readonly consoleMessages: Array<DiagnosticRecord>;
  readonly pageErrors: Array<DiagnosticRecord>;
  readonly requestIds: WeakMap<Request, string>;
  readonly requests: Map<string, NetworkRequestEntry>;
  readonly pageIds: WeakMap<Page, string>;
  readonly frameIds: WeakMap<Frame, string>;
  readonly cdpFrameUrls: WeakMap<Page, Map<string, string>>;
  readonly executionContexts: WeakMap<Page, Map<number, CdpFrameIdentity>>;
  readonly recentConsoleFrames: WeakMap<Page, RecentConsoleFrame>;
  readonly cdpRequests: WeakMap<Page, Map<string, CdpRequestIdentity>>;
  environment: SessionEnvironmentSettings;
  readonly pendingDialogs: Map<string, DialogRecord>;
  readonly pendingDialogIdsByPage: Map<string, Array<string>>;
  readonly evalOperations: Map<string, EvalOperation>;
  readonly evalPromises: Map<string, Promise<EvalCompletion>>;
  readonly evalCompletionResolvers: Map<string, (completion: EvalCompletion) => void>;
  readonly evalPendingResolvers: Map<string, (dialogId: string) => void>;
  readonly evalByPage: WeakMap<Page, string>;
  readonly evalDeadlines: Map<string, EvalDeadline>;
  readonly evalTimers: Map<string, EvalTimers>;
  activePage?: Page;
  activeContext?: BrowserContext;
  readonly heldModifiers: Set<string>;
  activeFrame?: Frame;
  activeFrameSelector?: string;
  nextRefNumber: number;
  nextPageId: number;
  nextFrameId: number;
  nextDialogId: number;
  nextOperationId: number;
  traceActive: boolean;
  profilerSession?: CDPSession;
  harActive: boolean;
  nextRequestId: number;
};
const MODIFIER_KEYS: Record<string, true> = {
  Alt: true,
  Control: true,
  Meta: true,
  Shift: true,
};

function modifierConflict(state: SessionRuntimeState): ControllerError | undefined {
  if (state.heldModifiers.size === 0) return undefined;
  return {
    _tag: "CommandFailed",
    message: `Held modifier(s): ${[...state.heldModifiers].join(", ")}. Release them with keyup before using a high-level input action`,
  };
}

function keyStateResult(state: SessionRuntimeState): KeyStateResult {
  return {
    _tag: "KeyStateResult",
    heldModifiers: [...state.heldModifiers],
  };
}

async function releaseHeldModifiers(
  page: Page,
  state: SessionRuntimeState,
): Promise<void> {
  for (const key of state.heldModifiers) {
    try {
      await page.keyboard.up(key);
    } catch {
      // The page may already be closed; state still must not leak into reuse.
    }
  }
  state.heldModifiers.clear();
}

const sessionRuntimeState = new Map<string, SessionRuntimeState>();

function initialSessionEnvironment(): SessionEnvironmentSettings {
  return {
    emulation: { _tag: "DefaultEmulation" },
    offline: { _tag: "Unset" },
    headers: { _tag: "Unset" },
    media: { _tag: "Unset" },
  };
}

function getSessionRuntimeState(sessionId: string): SessionRuntimeState {
  const existing = sessionRuntimeState.get(sessionId);
  if (existing) return existing;
  const created: SessionRuntimeState = {
    observedPages: new WeakSet<Page>(),
    observedContexts: new WeakSet<BrowserContext>(),
    cdpObservedPages: new WeakSet<Page>(),
    pageObservers: new WeakMap<Page, Promise<void>>(),
    pageNavigationGenerations: new WeakMap<Page, number>(),
    environmentPages: new WeakSet<Page>(),
    environmentPageSessions: new WeakMap<Page, CDPSession>(),
    environmentSessions: new Set<CDPSession>(),
    pageIds: new WeakMap<Page, string>(),
    observerSessions: new Set<CDPSession>(),
    pendingConsoleKeys: new Set<string>(),
    pendingErrorMessages: new Set<string>(),
    consoleMessages: [],
    pageErrors: [],
    requestIds: new WeakMap<Request, string>(),
    requests: new Map<string, NetworkRequestEntry>(),
    frameIds: new WeakMap<Frame, string>(),
    cdpFrameUrls: new WeakMap<Page, Map<string, string>>(),
    executionContexts: new WeakMap<Page, Map<number, CdpFrameIdentity>>(),
    recentConsoleFrames: new WeakMap<Page, RecentConsoleFrame>(),
    cdpRequests: new WeakMap<Page, Map<string, CdpRequestIdentity>>(),
    environment: initialSessionEnvironment(),
    pendingDialogs: new Map<string, DialogRecord>(),
    pendingDialogIdsByPage: new Map<string, Array<string>>(),
    evalOperations: new Map<string, EvalOperation>(),
    evalPromises: new Map<string, Promise<EvalCompletion>>(),
    evalCompletionResolvers: new Map<string, (completion: EvalCompletion) => void>(),
    evalPendingResolvers: new Map<string, (dialogId: string) => void>(),
    evalByPage: new WeakMap<Page, string>(),
    evalDeadlines: new Map<string, EvalDeadline>(),
    evalTimers: new Map<string, EvalTimers>(),
    nextRefNumber: 1,
    nextPageId: 1,
    nextDialogId: 1,
    nextOperationId: 1,
    heldModifiers: new Set<string>(),
    nextFrameId: 1,
    traceActive: false,
    harActive: false,
    nextRequestId: 1,
  };
  sessionRuntimeState.set(sessionId, created);
  return created;
}

function currentRefScope(state: SessionRuntimeState, page: Page): RefScope {
  return {
    page,
    ...(state.activeFrame === undefined ? {} : { frame: state.activeFrame }),
    navigationGeneration: state.pageNavigationGenerations.get(page) ?? 0,
  };
}

function invalidateRefs(refStore: RefStore, sessionId: string, reason: RefStaleReason): void {
  refStore.invalidate(sessionId, reason);
}

function resolveRef(
  refStore: RefStore,
  sessionId: string,
  ref: string,
  scope: RefScope,
): Result<Locator, ControllerError> {
  const detailed = refStore.resolveDetailed(sessionId, ref, scope);
  switch (detailed._tag) {
    case "Found":
      return ok(detailed.locator);
    case "Missing":
      return err({ _tag: "ElementNotFound", selector: ref });
    case "Stale":
      return err({ _tag: "StaleReference", ref, reason: detailed.reason });
    default:
      return exhaustive(detailed);
  }
}

type DiagnosticOverrides = {
  readonly pageUrl?: string;
  readonly frameId?: string;
  readonly frameUrl?: string;
};

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function safeFrameUrl(page: Page, frame: Frame | undefined): string {
  if (!frame) return safePageUrl(page);
  try {
    return frame.url() || safePageUrl(page);
  } catch {
    return safePageUrl(page);
  }
}

function pageIdentity(state: SessionRuntimeState, page: Page): string {
  const existing = state.pageIds.get(page);
  if (existing) return existing;
  const identity = `page-${state.nextPageId++}`;
  state.pageIds.set(page, identity);
  return identity;
}

function frameIdentity(state: SessionRuntimeState, frame: Frame): string {
  const existing = state.frameIds.get(frame);
  if (existing) return existing;
  const identity = `frame-${state.nextFrameId++}`;
  state.frameIds.set(frame, identity);
  return identity;
}

function diagnosticContext(
  state: SessionRuntimeState,
  sessionId: string,
  page: Page,
  frame?: Frame,
  overrides?: DiagnosticOverrides,
): DiagnosticContext {
  const pageUrl = overrides?.pageUrl ?? safePageUrl(page);
  const frameUrl = overrides?.frameUrl ?? safeFrameUrl(page, frame);
  const frameId = overrides?.frameId
    ?? (frame ? frameIdentity(state, frame) : "frame-main");
  return {
    sessionId,
    pageId: pageIdentity(state, page),
    frameId,
    pageUrl,
    frameUrl,
    timestamp: Date.now(),
  };
}

function diagnosticKey(record: DiagnosticRecord): string {
  switch (record._tag) {
    case "ConsoleDiagnostic":
      return `${record._tag}\0${record.type}\0${record.text}\0${record.pageId}\0${record.frameId}\0${record.pageUrl}`;
    case "PageErrorDiagnostic":
      return `${record._tag}\0${record.message}\0${record.pageId}\0${record.frameId}\0${record.pageUrl}`;
    case "ResourceFailureDiagnostic":
      return `${record._tag}\0${record.url}\0${record.status ?? ""}\0${record.pageId}\0${record.frameId}`;
    case "PolicyBlockedDiagnostic":
      return `${record._tag}\0${record.url}\0${record.policy}\0${record.text}\0${record.pageId}\0${record.frameId}`;
    default:
      return exhaustive(record);
  }
}

function appendDiagnostic(
  target: Array<DiagnosticRecord>,
  pending: Set<string>,
  record: DiagnosticRecord,
): void {
  const key = diagnosticKey(record);
  if (pending.has(key)) return;
  pending.add(key);
  queueMicrotask(() => pending.delete(key));
  target.push(record);
}

function consoleDiagnostic(
  context: DiagnosticContext,
  type: string,
  text: string,
): ConsoleDiagnostic | PolicyBlockedDiagnostic {
  if (isPolicyBlocked(undefined, text)) {
    return {
      ...context,
      _tag: "PolicyBlockedDiagnostic",
      url: extractUrl(text) ?? context.frameUrl,
      policy: "csp",
      text,
    };
  }
  return { ...context, _tag: "ConsoleDiagnostic", type, text };
}

function recordConsole(state: SessionRuntimeState, record: DiagnosticRecord): void {
  appendDiagnostic(state.consoleMessages, state.pendingConsoleKeys, record);
}

function recordPageError(state: SessionRuntimeState, record: DiagnosticRecord): void {
  appendDiagnostic(state.pageErrors, state.pendingErrorMessages, record);
}

function extractUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s'"]+/.exec(text);
  return match?.[0]?.replace(/[),.;]+$/, "");
}

function isPolicyBlocked(reason: string | undefined, text: string): boolean {
  const value = `${reason ?? ""} ${text}`.toLowerCase();
  return value.includes("csp")
    || value.includes("content security policy")
    || value.includes("violates the following")
    || value.includes("refused to load")
    || value.includes("blocked by policy");
}

function requestFrame(request: Request, page: Page): Frame | undefined {
  try {
    return request.frame();
  } catch {
    return page.mainFrame();
  }
}

function cdpFrameUrlsFor(
  state: SessionRuntimeState,
  page: Page,
): Map<string, string> {
  const existing = state.cdpFrameUrls.get(page);
  if (existing) return existing;
  const created = new Map<string, string>();
  state.cdpFrameUrls.set(page, created);
  return created;
}

function executionContextsFor(
  state: SessionRuntimeState,
  page: Page,
): Map<number, CdpFrameIdentity> {
  const existing = state.executionContexts.get(page);
  if (existing) return existing;
  const created = new Map<number, CdpFrameIdentity>();
  state.executionContexts.set(page, created);
  return created;
}

function cdpRequestsFor(
  state: SessionRuntimeState,
  page: Page,
): Map<string, CdpRequestIdentity> {
  const existing = state.cdpRequests.get(page);
  if (existing) return existing;
  const created = new Map<string, CdpRequestIdentity>();
  state.cdpRequests.set(page, created);
  return created;
}

function cdpFrameOverrides(
  state: SessionRuntimeState,
  page: Page,
  frameId: string | undefined,
  frameUrl: string | undefined,
): DiagnosticOverrides | undefined {
  if (!frameId && !frameUrl) return undefined;
  const knownUrl = frameId ? state.cdpFrameUrls.get(page)?.get(frameId) : undefined;
  return {
    ...(frameId === undefined ? {} : { frameId: `cdp-${frameId}` }),
    frameUrl: frameUrl ?? knownUrl ?? safePageUrl(page),
  };
}

type DialogTarget = {
  readonly dialogId?: string;
  readonly pageId?: string;
};

const DIALOG_HANDLER_GRACE_MS = 3_000;

function pageIdFor(state: SessionRuntimeState, page: Page): string {
  const existing = state.pageIds.get(page);
  if (existing !== undefined) return existing;
  const id = `page-${state.nextPageId++}`;
  state.pageIds.set(page, id);
  return id;
}

function pageUrlFor(page: Page): string {
  try {
    return page.url();
  } catch {
    return "closed";
  }
}
function dialogTypeFor(dialog: Dialog): DialogType {
  const value = dialog.type();
  if (
    value === "alert"
    || value === "beforeunload"
    || value === "confirm"
    || value === "prompt"
  ) {
    return value;
  }
  return "unknown";
}


function dialogPageFor(
  state: SessionRuntimeState,
  context: BrowserContext,
  page: Page,
): DialogPage {
  return {
    pageId: pageIdFor(state, page),
    pageIndex: context.pages().indexOf(page),
    pageUrl: pageUrlFor(page),
  };
}

function evalOperationForPage(
  state: SessionRuntimeState,
  page: Page,
): EvalOperation | undefined {
  const operationId = state.evalByPage.get(page);
  return operationId === undefined ? undefined : state.evalOperations.get(operationId);
}

function clearEvalLifecycle(state: SessionRuntimeState, operationId: string): void {
  const timers = state.evalTimers.get(operationId);
  if (timers !== undefined) {
    clearTimeout(timers.grace);
    if (timers.deadline._tag === "Timer") clearTimeout(timers.deadline.handle);
    state.evalTimers.delete(operationId);
  }
  state.evalDeadlines.delete(operationId);
}

function operationErrorText(error: ControllerError): string {
  return JSON.stringify(error) ?? error._tag;
}

function dialogOperationFor(
  state: SessionRuntimeState,
  initiator: DialogInitiator,
): DialogOperation {
  switch (initiator._tag) {
    case "NoEval":
      return { _tag: "NoOperation" };
    case "Eval": {
      const operation = state.evalOperations.get(initiator.operationId);
      if (operation === undefined) {
        return {
          _tag: "FailedOperation",
          operationId: initiator.operationId,
          error: "dialog evaluation operation is no longer available",
        };
      }
      switch (operation._tag) {
        case "Running":
        case "DialogObserved":
        case "Pending":
          return { _tag: "PendingOperation", operationId: operation.operationId };
        case "Settled":
          return {
            _tag: "SettledOperation",
            operationId: operation.operationId,
            result: operation.result,
          };
        case "Failed":
          return {
            _tag: "FailedOperation",
            operationId: operation.operationId,
            error: operationErrorText(operation.error),
          };
        case "TimedOut":
          return {
            _tag: "TimedOutOperation",
            operationId: operation.operationId,
            operation: operation.operation,
          };
        default:
          return exhaustive(operation);
      }
    }
    default:
      return exhaustive(initiator);
  }
}

function settleEvalOperation(
  state: SessionRuntimeState,
  operationId: string,
  completion: EvalCompletion,
): void {
  const operation = state.evalOperations.get(operationId);
  if (operation === undefined) return;

  switch (operation._tag) {
    case "Running":
      state.evalOperations.delete(operationId);
      state.evalPromises.delete(operationId);
      state.evalByPage.delete(operation.page);
      clearEvalLifecycle(state, operationId);
      break;
    case "DialogObserved":
    case "Pending":
      state.evalByPage.delete(operation.page);
      clearEvalLifecycle(state, operationId);
      if (completion._tag === "Resolved") {
        state.evalOperations.set(operationId, {
          _tag: "Settled",
          operationId,
          page: operation.page,
          dialogId: operation.dialogId,
          result: completion.result,
        });
      } else {
        state.evalOperations.set(operationId, {
          _tag: "Failed",
          operationId,
          page: operation.page,
          dialogId: operation.dialogId,
          error: completion.error,
        });
      }
      break;
    case "Settled":
    case "Failed":
    case "TimedOut":
      return;
    default:
      return exhaustive(operation);
  }
  state.evalPendingResolvers.delete(operationId);
  const resolver = state.evalCompletionResolvers.get(operationId);
  if (resolver !== undefined) {
    state.evalCompletionResolvers.delete(operationId);
    resolver(completion);
  }
}

function markEvalTimeout(sessionId: string, state: SessionRuntimeState, operationId: string): void {
  const operation = state.evalOperations.get(operationId);
  if (
    operation === undefined
    || (operation._tag !== "DialogObserved" && operation._tag !== "Pending")
  ) {
    return;
  }
  const deadline = state.evalDeadlines.get(operationId);
  const budget = deadline?._tag === "Deadline" ? deadline.budget : 0;
  const pageId = pageIdFor(state, operation.page);
  const timeoutOperation =
    `dialog/eval phase=dialog-handler budget=${budget}ms session=${sessionId} ` +
    `operation=${operationId} page=${pageId} dialog=${operation.dialogId} ` +
    "result may include partial side effects";
  const error: ControllerError = { _tag: "Timeout", operation: timeoutOperation };

  state.evalOperations.set(operationId, {
    _tag: "TimedOut",
    operationId,
    page: operation.page,
    dialogId: operation.dialogId,
    operation: timeoutOperation,
  });
  state.evalByPage.delete(operation.page);
  clearEvalLifecycle(state, operationId);
  // The modal itself keeps the page evaluation blocked, but the operation is
  // now terminal and no longer needs a state-held promise reference. An
  // explicit dialog handler may still release the browser-side evaluation.
  state.evalPromises.delete(operationId);

  const pendingResolver = state.evalPendingResolvers.get(operationId);
  if (pendingResolver !== undefined) {
    state.evalPendingResolvers.delete(operationId);
    pendingResolver(operation.dialogId);
  }
  const completionResolver = state.evalCompletionResolvers.get(operationId);
  if (completionResolver !== undefined) {
    state.evalCompletionResolvers.delete(operationId);
    completionResolver({ _tag: "Rejected", error });
  }

}

function scheduleDialogTimers(
  sessionId: string,
  state: SessionRuntimeState,
  operationId: string,
  dialogId: string,
): void {
  if (state.evalTimers.has(operationId)) return;
  const storedDeadline = state.evalDeadlines.get(operationId);
  const deadline: EvalDeadline = storedDeadline ?? { _tag: "NoDeadline" };
  const graceDelay = deadline._tag === "Deadline"
    ? Math.min(
      DIALOG_HANDLER_GRACE_MS,
      Math.max(1, deadline.at - Date.now() - CDP_DEADLINE_GUARD_MS),
    )
    : DIALOG_HANDLER_GRACE_MS;
  const grace = setTimeout(() => {
    const operation = state.evalOperations.get(operationId);
    if (operation?._tag !== "DialogObserved") return;
    state.evalOperations.set(operationId, {
      _tag: "Pending",
      operationId,
      page: operation.page,
      dialogId: operation.dialogId,
      completion: operation.completion,
    });
    const resolver = state.evalPendingResolvers.get(operationId);
    if (resolver !== undefined) {
      state.evalPendingResolvers.delete(operationId);
      resolver(dialogId);
    }
  }, graceDelay);

  const deadlineTimer: EvalDeadlineTimer = deadline._tag === "Deadline"
    ? {
        _tag: "Timer",
        handle: setTimeout(
          () => markEvalTimeout(sessionId, state, operationId),
          Math.max(1, deadline.at - Date.now()),
        ),
      }
    : { _tag: "NoTimer" };
  state.evalTimers.set(operationId, { grace, deadline: deadlineTimer });
}

function registerDialog(
  sessionId: string,
  page: Page,
  dialog: Dialog,
): DialogRecord {
  const state = getSessionRuntimeState(sessionId);
  const pageId = pageIdFor(state, page);
  const activeOperation = evalOperationForPage(state, page);
  const dialogId = `dialog-${state.nextDialogId++}`;
  let initiator: DialogInitiator = { _tag: "NoEval" };
  if (activeOperation?._tag === "Running") {
    initiator = { _tag: "Eval", operationId: activeOperation.operationId };
    state.evalOperations.set(activeOperation.operationId, {
      _tag: "DialogObserved",
      operationId: activeOperation.operationId,
      page,
      dialogId,
      completion: activeOperation.completion,
    });
  }
  const record: DialogRecord = {
    dialogId,
    pageId,
    page,
    dialog,
    type: dialogTypeFor(dialog),
    message: dialog.message(),
    defaultPrompt: dialog.defaultValue(),
    initiator,
  };
  state.pendingDialogs.set(record.dialogId, record);
  const existing = state.pendingDialogIdsByPage.get(pageId) ?? [];
  state.pendingDialogIdsByPage.set(pageId, [...existing, record.dialogId]);
  if (initiator._tag === "Eval") {
    scheduleDialogTimers(sessionId, state, initiator.operationId, record.dialogId);
  }
  return record;
}

function removeDialog(state: SessionRuntimeState, record: DialogRecord): void {
  state.pendingDialogs.delete(record.dialogId);
  const remaining = (state.pendingDialogIdsByPage.get(record.pageId) ?? [])
    .filter((id) => id !== record.dialogId);
  if (remaining.length === 0) state.pendingDialogIdsByPage.delete(record.pageId);
  else state.pendingDialogIdsByPage.set(record.pageId, remaining);
}

function findDialog(
  state: SessionRuntimeState,
  page: Page,
  target: DialogTarget,
): DialogRecord | undefined {
  const pageId = pageIdFor(state, page);
  if (target.pageId !== undefined && target.pageId !== pageId) return undefined;
  if (target.dialogId !== undefined) {
    const dialog = state.pendingDialogs.get(target.dialogId);
    return dialog?.page === page ? dialog : undefined;
  }
  const ids = state.pendingDialogIdsByPage.get(pageId) ?? [];
  for (const id of ids) {
    const dialog = state.pendingDialogs.get(id);
    if (dialog !== undefined) return dialog;
  }
  return undefined;
}

function dialogResultFor(
  state: SessionRuntimeState,
  context: BrowserContext,
  record: DialogRecord,
  stateName: "open" | "pending",
): DialogResult {
  return {
    _tag: "DialogResult",
    state: stateName,
    hasDialog: true,
    dialogId: record.dialogId,
    page: dialogPageFor(state, context, record.page),
    type: record.type,
    message: record.message,
    defaultPrompt: record.defaultPrompt,
    operation: dialogOperationFor(state, record.initiator),
  };
}

function operationDialogResult(
  state: SessionRuntimeState,
  operationId: string,
): Result<CommandResultData, ControllerError> {
  const operation = state.evalOperations.get(operationId);
  if (operation === undefined) {
    return err({ _tag: "ElementNotFound", selector: `operation:${operationId}` });
  }
  if (operation._tag === "TimedOut") return err({
    _tag: "Timeout",
    operation: operation.operation,
  });
  return ok({
    _tag: "DialogResult",
    state: "operation",
    hasDialog: false,
    operationId,
    operation: dialogOperationFor(state, { _tag: "Eval", operationId }),
  });
}

function operationCompletion(
  promise: Promise<EvalCompletion>,
  timeout: number | undefined,
): Promise<EvalCompletion | undefined> {
  if (timeout === undefined) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeout);
    void promise.then((completion) => {
      clearTimeout(timer);
      resolve(completion);
    });
  });
}

function observePageRuntime(sessionId: string, page: Page): SessionRuntimeState {
  const state = getSessionRuntimeState(sessionId);
  pageIdentity(state, page);
  if (state.observedPages.has(page)) return state;
  state.observedPages.add(page);
  state.pageNavigationGenerations.set(page, 0);
  page.on("framenavigated", (frame) => {
    const generation = state.pageNavigationGenerations.get(page) ?? 0;
    state.pageNavigationGenerations.set(page, generation + 1);
    if (state.activePage === page && frame === page.mainFrame()) {
      state.activeFrame = undefined;
      state.activeFrameSelector = undefined;
    }
  });
  page.on("console", (message) => {
    if (state.cdpObservedPages.has(page)) return;
    const location = message.location();
    const context = diagnosticContext(state, sessionId, page, undefined, {
      ...(location.url === "" ? {} : { frameUrl: location.url }),
    });
    recordConsole(state, consoleDiagnostic(context, message.type(), message.text()));
  });
  page.on("pageerror", (error) => {
    if (state.cdpObservedPages.has(page)) return;
    const context = diagnosticContext(state, sessionId, page);
    recordPageError(state, {
      ...context,
      _tag: "PageErrorDiagnostic",
      message: error.message,
    });
  });
  page.on("dialog", (dialog) => {
    registerDialog(sessionId, page, dialog);
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
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const frame = requestFrame(request, page);
    const context = diagnosticContext(state, sessionId, page, frame);
    recordConsole(state, {
      ...context,
      _tag: "ResourceFailureDiagnostic",
      url: request.url(),
      resourceType: request.resourceType(),
      ...(failure?.errorText === undefined ? {} : { errorText: failure.errorText }),
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    const requestId = state.requestIds.get(request);
    if (!requestId) return;
    const current = state.requests.get(requestId);
    if (!current) return;
    const status = response.status();
    state.requests.set(requestId, {
      ...current,
      status,
      responseHeaders: response.headers(),
    });
    if (status >= 400) {
      const context = diagnosticContext(state, sessionId, page, requestFrame(request, page));
      recordConsole(state, {
        ...context,
        _tag: "ResourceFailureDiagnostic",
        url: response.url(),
        resourceType: request.resourceType(),
        status,
      });
    }
    response.text().then((responseBody) => {
      const latest = state.requests.get(requestId);
      if (latest) state.requests.set(requestId, { ...latest, responseBody });
    }).catch(() => {});
  });
  return state;
}

async function executeEvalWithDialog(
  sessionId: string,
  context: BrowserContext,
  page: Page,
  scope: Page | Frame,
  code: string,
  options?: CommandExecutionOptions,
): Promise<Result<CommandResultData, ControllerError>> {
  const state = getSessionRuntimeState(sessionId);
  const activeOperation = evalOperationForPage(state, page);
  switch (activeOperation?._tag) {
    case "DialogObserved":
    case "Pending":
      return err({
        _tag: "DialogPending",
        operationId: activeOperation.operationId,
        dialogId: activeOperation.dialogId,
        page: dialogPageFor(state, context, activeOperation.page),
      });
    case "Running":
      return err({
        _tag: "CommandFailed",
        message: "The active page already has an unresolved evaluation",
      });
    case "Settled":
    case "Failed":
    case "TimedOut":
    case undefined:
      break;
    default:
      return exhaustive(activeOperation);
  }

  const operationId = `operation-${state.nextOperationId++}`;
  const completion = new Promise<EvalCompletion>((resolve) => {
    state.evalCompletionResolvers.set(operationId, resolve);
  });
  state.evalPromises.set(operationId, completion);
  state.evalOperations.set(operationId, {
    _tag: "Running",
    operationId,
    page,
    completion,
  });
  state.evalByPage.set(page, operationId);
  state.evalDeadlines.set(
    operationId,
    options === undefined
      ? { _tag: "NoDeadline" }
      : { _tag: "Deadline", at: options.deadline, budget: options.budget },
  );
  const pendingDialog = new Promise<string>((resolve) => {
    state.evalPendingResolvers.set(operationId, resolve);
  });

  void Promise.resolve()
    .then(() => scope.evaluate(code))
    .then(
      (raw) => {
        const result: EvalResult = { _tag: "EvalResult", result: JSON.stringify(raw) };
        settleEvalOperation(state, operationId, { _tag: "Resolved", result });
      },
      (error: unknown) => {
        settleEvalOperation(state, operationId, {
          _tag: "Rejected",
          error: mapPlaywrightError(error, "eval", options),
        });
      },
    );

  const decision = await Promise.race([
    completion.then((value) => ({ _tag: "Completion", value }) as const),
    pendingDialog.then((dialogId) => ({ _tag: "Pending", dialogId }) as const),
  ]);
  switch (decision._tag) {
    case "Completion":
      return decision.value._tag === "Resolved"
        ? ok(decision.value.result)
        : err(decision.value.error);
    case "Pending": {
      const operation = state.evalOperations.get(operationId);
      if (operation?._tag === "TimedOut") {
        return err({ _tag: "Timeout", operation: operation.operation });
      }
      const dialog = state.pendingDialogs.get(decision.dialogId);
      if (dialog === undefined) {
        return err({
          _tag: "CommandFailed",
          message: `Dialog ${decision.dialogId} disappeared before pending response`,
        });
      }
      return ok(dialogResultFor(state, context, dialog, "pending"));
    }
    default:
      return exhaustive(decision);
  }
}

function observeContextRuntime(
  sessionId: string,
  context: BrowserContext,
): SessionRuntimeState {
  const state = getSessionRuntimeState(sessionId);
  state.activeContext = context;
  if (!state.observedContexts.has(context)) {
    state.observedContexts.add(context);
    context.on("page", (page) => {
      observePageRuntime(sessionId, page);
    });
  }
  for (const page of context.pages()) observePageRuntime(sessionId, page);
  return state;
}

async function ensureCdpRuntimeObserver(
  sessionId: string,
  context: BrowserContext,
  page: Page,
  options?: CommandExecutionOptions,
): Promise<void> {
  const state = getSessionRuntimeState(sessionId);
  const existingObserver = state.pageObservers.get(page);
  if (existingObserver) {
    const observerOptions = cdpObserverOptions(options);
    if (observerOptions !== undefined) {
      try {
        await withOperationTimeout(() => existingObserver, observerOptions);
      } catch {
        // A slow observer must not consume the calling command's deadline.
      }
    }
    return;
  }
  let observer: Promise<void> | undefined;
  observer = (async () => {
    await Promise.resolve();
    const observerOptions = cdpObserverOptions(options);
    if (observerOptions === undefined) {
      if (state.pageObservers.get(page) === observer) state.pageObservers.delete(page);
      return;
    }


    let cdp: CDPSession | undefined;
    let committed = false;
    let abandoned = false;
    let detached = false;
    const detach = (session: CDPSession): void => {
      void session.detach().catch(() => {});
    };
    const abandon = (): void => {
      abandoned = true;
      committed = false;
      if (cdp === undefined) return;
      state.observerSessions.delete(cdp);
      state.cdpObservedPages.delete(page);
      if (detached) return;
      detached = true;
      detach(cdp);
    };

    try {
      const sessionPromise = context.newCDPSession(page);
      void sessionPromise.then((session) => {
        if (abandoned) detach(session);
      }, () => {});
      const session = await withOperationTimeout(() => sessionPromise, observerOptions);
      if (abandoned) {
        detach(session);
        return;
      }
      cdp = session;
      state.observerSessions.add(session);
      cdp.on("Page.frameNavigated", (event: CdpFrameNavigatedEvent) => {
        if (!committed) return;
        cdpFrameUrlsFor(state, page).set(event.frame.id, event.frame.url);
      });
      cdp.on("Runtime.executionContextCreated", (event: CdpExecutionContextEvent) => {
        if (!committed) return;
        const frameId = event.context.auxData?.frameId;
        if (frameId === undefined) return;
        const frameUrls = cdpFrameUrlsFor(state, page);
        const frameUrl = frameUrls.get(frameId) ?? event.context.origin ?? safePageUrl(page);
        frameUrls.set(frameId, frameUrl);
        executionContextsFor(state, page).set(event.context.id, { frameId, frameUrl });
      });
      cdp.on("Network.requestWillBeSent", (event: CdpRequestEvent) => {
        if (!committed) return;
        cdpRequestsFor(state, page).set(event.requestId, {
          url: event.request.url,
          ...(event.frameId === undefined ? {} : { frameId: event.frameId }),
          ...(event.type === undefined ? {} : { resourceType: event.type.toLowerCase() }),
        });
      });
      cdp.on("Network.loadingFailed", (event: CdpLoadingFailedEvent) => {
        if (!committed) return;
        const request = cdpRequestsFor(state, page).get(event.requestId);
        const text = event.errorText ?? event.blockedReason ?? "Resource loading failed";
        if (!isPolicyBlocked(event.blockedReason, text)) return;
        const contextInfo = cdpFrameOverrides(state, page, event.frameId ?? request?.frameId, request?.url);
        const diagnostic = diagnosticContext(state, sessionId, page, undefined, contextInfo);
        recordConsole(state, {
          ...diagnostic,
          _tag: "PolicyBlockedDiagnostic",
          url: request?.url ?? diagnostic.frameUrl,
          ...(event.type === undefined && request?.resourceType === undefined
            ? {}
            : { resourceType: (event.type ?? request?.resourceType)?.toLowerCase() }),
          policy: event.blockedReason ?? "csp",
          text,
        });
      });
      cdp.on("Log.entryAdded", (event: CdpLogEvent) => {
        if (!committed) return;
        const entry = event.entry;
        if (!isPolicyBlocked(entry.source, entry.text)) return;
        const request = entry.networkRequestId === undefined
          ? undefined
          : cdpRequestsFor(state, page).get(entry.networkRequestId);
        const url = extractUrl(entry.text) ?? request?.url ?? entry.url;
        const contextInfo = cdpFrameOverrides(state, page, request?.frameId, entry.url);
        const diagnostic = diagnosticContext(state, sessionId, page, undefined, contextInfo);
        recordConsole(state, {
          ...diagnostic,
          _tag: "PolicyBlockedDiagnostic",
          url: url ?? diagnostic.frameUrl,
          policy: entry.source ?? "csp",
          text: entry.text,
        });
      });
      cdp.on("Runtime.consoleAPICalled", (event: CdpConsoleEvent) => {
        if (!committed) return;
        const text = event.args.map((arg) => {
          if (arg.value !== undefined) return String(arg.value);
          return arg.description ?? arg.type;
        }).join(" ");
        const frame = event.executionContextId === undefined
          ? undefined
          : executionContextsFor(state, page).get(event.executionContextId);
        if (frame) {
          state.recentConsoleFrames.set(page, { ...frame, timestamp: Date.now() });
        }
        const contextInfo = cdpFrameOverrides(state, page, frame?.frameId, frame?.frameUrl);
        const context = diagnosticContext(state, sessionId, page, undefined, contextInfo);
        recordConsole(state, consoleDiagnostic(context, event.type, text));
      });
      cdp.on("Runtime.exceptionThrown", (event: CdpExceptionEvent) => {
        if (!committed) return;
        const details = event.exceptionDetails;
        const directFrame = details.executionContextId === undefined
          ? undefined
          : executionContextsFor(state, page).get(details.executionContextId);
        const recentFrame = state.recentConsoleFrames.get(page);
        const frame = recentFrame !== undefined
          && Date.now() - recentFrame.timestamp <= 500
          && directFrame?.frameId !== recentFrame.frameId
          ? recentFrame
          : directFrame;
        const contextInfo = cdpFrameOverrides(state, page, frame?.frameId, details.url ?? frame?.frameUrl);
        const context = diagnosticContext(state, sessionId, page, undefined, contextInfo);
        recordPageError(state, {
          ...context,
          _tag: "PageErrorDiagnostic",
          message: details.exception?.description ?? details.text,
        });
      });
      await withOperationTimeout(() => session.send("Runtime.enable"), observerOptions);
      await withOperationTimeout(() => session.send("Network.enable"), observerOptions);
      await withOperationTimeout(() => session.send("Log.enable"), observerOptions);
      await withOperationTimeout(() => session.send("Page.enable"), observerOptions);
      if (abandoned) return;
      committed = true;
      state.cdpObservedPages.add(page);
    } catch {
      abandon();
    } finally {
      if (!committed) {
        abandon();
        if (state.pageObservers.get(page) === observer) state.pageObservers.delete(page);
      }
    }
  })();
  state.pageObservers.set(page, observer);
  await observer;
}

export function clearSessionRuntimeState(sessionId: string): void {
  const state = sessionRuntimeState.get(sessionId);
  if (state) {
    for (const cdp of state.observerSessions) void cdp.detach().catch(() => {});
    for (const timers of state.evalTimers.values()) {
      clearTimeout(timers.grace);
      if (timers.deadline._tag === "Timer") clearTimeout(timers.deadline.handle);
    }
    state.evalTimers.clear();
    state.evalDeadlines.clear();
    state.evalPendingResolvers.clear();
    state.evalCompletionResolvers.clear();
    state.evalPromises.clear();
    state.evalOperations.clear();
    state.pendingDialogs.clear();
    state.pendingDialogIdsByPage.clear();
    state.heldModifiers.clear();
    for (const cdp of state.environmentSessions) void cdp.detach().catch(() => {});
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

// ─── Locator subaction type ───

type LocatorSubaction = NthSubaction;

// ─── executeLocatorAction ───

async function executeLocatorAction(
  locator: Locator,
  subaction: LocatorSubaction | undefined,
  state: SessionRuntimeState,
  value?: string,
  options?: CommandExecutionOptions,
): Promise<Result<CommandResultData, ControllerError>> {
  if (subaction !== undefined) {
    const conflict = modifierConflict(state);
    if (conflict) return err(conflict);
  }
  const timeout = operationTimeout(options);
  switch (subaction) {
    case undefined: {
      const count = await locator.count();
      if (count === 0) return err({ _tag: "ElementNotFound" } as const);
      const result: LocatorResult = { _tag: "LocatorResult", found: true, count };
      return ok(result);
    }

    case "click":
      await locator.click({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "fill":
      await locator.fill(value!, { timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      await locator.pressSequentially(value!, { timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "check":
      await locator.check({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "uncheck":
      await locator.uncheck({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "hover":
      await locator.hover({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "dblclick":
      await locator.dblclick({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "focus":
      await locator.focus({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "select":
      if (value === undefined) {
        return err({ _tag: "ValidationFailed", message: "select requires a value" });
      }
      await locator.selectOption([value], { timeout });
      return ok({ _tag: "VoidResult" } as const);

    default:
      return exhaustive(subaction);
  }
}

// ─── resolveLocator ───

function resolveLocator(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  refScope: RefScope,
  ref?: string,
  selector?: string,
): Result<Locator, ControllerError> {
  if (ref) return resolveRef(refStore, sessionId, ref, refScope);
  if (selector) return ok(scope.locator(selector));
  return err({ _tag: "ElementNotFound" });
}

// ─── executeElementAction ───
async function executeElementAction(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  refScope: RefScope,
  ref: string | undefined,
  selector: string | undefined,
  action: "click" | "fill" | "type" | "hover",
  state: SessionRuntimeState,
  value?: string,
  options?: CommandExecutionOptions,
): Promise<Result<CommandResultData, ControllerError>> {
  const resolved = resolveLocator(scope, refStore, sessionId, refScope, ref, selector);
  if (resolved._tag === "Err") return resolved;
  const conflict = modifierConflict(state);
  if (conflict) return err(conflict);
  const locator = resolved.value;
  const timeout = operationTimeout(options);

  switch (action) {
    case "click":
      await locator.click({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "fill":
      await locator.fill(value!, { timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "type":
      await locator.pressSequentially(value!, { timeout });
      return ok({ _tag: "VoidResult" } as const);

    case "hover":
      await locator.hover({ timeout });
      return ok({ _tag: "VoidResult" } as const);

    default:
      return exhaustive(action);
  }
}
async function executeNewTabClick(
  context: BrowserContext,
  page: Page,
  locator: Locator,
  sessionId: string,
  runtimeState: SessionRuntimeState,
  options?: CommandExecutionOptions,
): Promise<Result<CommandResultData, ControllerError>> {
  const href = await locator.getAttribute("href", { timeout: operationTimeout(options) });
  if (href === null || href.trim() === "") {
    return err({
      _tag: "CommandFailed",
      message: "click --new-tab requires an element with a non-empty href",
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(href, page.url());
  } catch {
    return err({
      _tag: "CommandFailed",
      message: `click --new-tab received an invalid href: ${href}`,
    });
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return err({
      _tag: "CommandFailed",
      message: `click --new-tab cannot open href with protocol ${targetUrl.protocol}`,
    });
  }

  const newPage = await withOperationTimeout(() => context.newPage(), options);
  observePageRuntime(sessionId, newPage);
  await ensureCdpRuntimeObserver(sessionId, context, newPage, options);
  try {
    await applySessionEnvironmentToNewPage(
      context,
      newPage,
      runtimeState,
      runtimeState.environment,
      options,
    );
    runtimeState.environmentPages.add(newPage);
    await withOperationTimeout(
      () => newPage.goto(targetUrl.toString(), { timeout: operationTimeout(options) }),
      options,
    );
    await reapplySessionPageEnvironment(context, newPage, runtimeState, options);
  } catch (error) {
    await newPage.close().catch(() => {});
    return err(mapPlaywrightError(error, "click", options));
  }

  const newIndex = context.pages().indexOf(newPage);
  if (newIndex < 0) {
    await newPage.close().catch(() => {});
    return err({
      _tag: "CommandFailed",
      message: "click --new-tab opened a page that is no longer available",
    });
  }
  sessionTabIndex.set(sessionId, newIndex);
  return ok({ _tag: "VoidResult" } as const);
}

// ─── buildAriaSnapshot ───

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "option",
]);

// Matches lines like "- button "Submit"" or "  - textbox "Name" [attr=val]"
const ARIA_LINE_RE = /^(\s*- )(\w+)(?: "([^"]*)")?(.*)$/;

async function buildAriaSnapshot(
  scope: Page | Frame,
  refStore: RefStore,
  sessionId: string,
  refScope: RefScope,
  options: {
    readonly selector?: string;
    readonly ref?: string;
    readonly interactive?: boolean;
    readonly compact?: boolean;
    readonly maxDepth?: number;
  } = {},
): Promise<Result<string, ControllerError>> {
  let root: Locator;
  if (options.ref) {
    const resolved = resolveRef(refStore, sessionId, options.ref, refScope);
    if (resolved._tag === "Err") return resolved;
    root = resolved.value;
  } else {
    root = scope.locator(options.selector ?? "body");
  }
  const snapshot = await root.ariaSnapshot();
  const refs = new Map<string, Locator>();
  const state = getSessionRuntimeState(sessionId);
  const roleOccurrences = new Map<string, number>();

  const annotated = snapshot.split("\n").filter((line) => {
    if (options.maxDepth !== undefined) {
      const indentation = line.length - line.trimStart().length;
      if (Math.floor(indentation / 2) > options.maxDepth) return false;
    }
    if (!options.interactive) return true;
    const match = ARIA_LINE_RE.exec(line);
    return match !== null && INTERACTIVE_ROLES.has(match[2]);
  }).map((line) => {
    const m = ARIA_LINE_RE.exec(line);
    if (!m) return line;

    const [, indent, role, name, rest] = m;
    if (!INTERACTIVE_ROLES.has(role)) return line;

    const roleIndex = roleOccurrences.get(role) ?? 0;
    roleOccurrences.set(role, roleIndex + 1);
    const key = `@e${state.nextRefNumber++}`;
    const locator = root
      .getByRole(role as Parameters<Page["getByRole"]>[0])
      .nth(roleIndex);
    refs.set(key, locator);

    return name
      ? `${indent}${key} ${role} "${name}"${rest}`
      : `${indent}${key} ${role}${rest}`;
  }).filter((line) => !options.compact || line.trim().length > 0).join("\n");

  refStore.update(sessionId, refs, refScope);
  return ok(annotated);
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
  refScope: RefScope,
): Promise<Result<ReadonlyArray<ScreenshotAnnotation>, ControllerError>> {
  const snapshotResult = await buildAriaSnapshot(
    scope,
    refStore,
    sessionId,
    refScope,
    { interactive: true },
  );
  if (snapshotResult._tag === "Err") return snapshotResult;
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
  return ok(annotations);
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
type StorageStateOrigin = {
  readonly origin: string;
  readonly localStorage: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly indexedDB?: ReadonlyArray<IndexedDbDatabase>;
};

type StorageState = {
  readonly cookies: ReadonlyArray<CookieEntry>;
  readonly origins: ReadonlyArray<StorageStateOrigin>;
};

type StatePageTarget = {
  readonly page: Page;
};

function stateOrigin(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function stateLoadCounts(state: BrowserStorageState): StateLoadCounts {
  return {
    cookies: state.cookies.length,
    origins: state.origins.length,
    tabs: state.tabs.length,
    indexedDB: state.origins.reduce((count, origin) => count + origin.indexedDB.length, 0),
  };
}

async function restoreIndexedDb(
  page: Page,
  databases: ReadonlyArray<IndexedDbDatabase>,
  options?: CommandExecutionOptions,
): Promise<boolean> {
  if (databases.length === 0) return true;
  return withOperationTimeout(() => page.evaluate(async (state) => {
    const readProperty = (value: object, name: string): unknown =>
      Object.getOwnPropertyDescriptor(value, name)?.value;

    const decode = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map((item) => decode(item));
      if (value === null || typeof value !== "object") return value;

      const marker = readProperty(value, "v");
      if (marker === "undefined") return undefined;
      if (marker === "null") return null;
      if (marker === "NaN") return Number.NaN;
      if (marker === "Infinity") return Number.POSITIVE_INFINITY;
      if (marker === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (marker === "-0") return -0;
      const date = readProperty(value, "d");
      if (typeof date === "string") return new Date(date);
      const url = readProperty(value, "u");
      if (typeof url === "string") return new URL(url);
      const bigint = readProperty(value, "bi");
      if (typeof bigint === "string") return BigInt(bigint);
      const regexp = readProperty(value, "r");
      if (regexp !== null && typeof regexp === "object") {
        const pattern = readProperty(regexp, "p");
        const flags = readProperty(regexp, "f");
        if (typeof pattern === "string" && typeof flags === "string") return new RegExp(pattern, flags);
      }
      const encodedArray = readProperty(value, "a");
      if (Array.isArray(encodedArray)) return encodedArray.map((item) => decode(item));
      const encodedObject = readProperty(value, "o");
      if (Array.isArray(encodedObject)) {
        const result: Record<string, unknown> = {};
        for (const entry of encodedObject) {
          if (entry === null || typeof entry !== "object") continue;
          const key = readProperty(entry, "k");
          if (typeof key !== "string") continue;
          result[key] = decode(readProperty(entry, "v"));
        }
        return result;
      }
      return value;
    };

    const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });

    const isValidKey = (value: unknown): value is IDBValidKey => {
      if (typeof value === "string" || typeof value === "number") return true;
      if (value instanceof Date) return true;
      return Array.isArray(value) && value.every((item) => isValidKey(item));
    };

    const transactionResult = (transaction: IDBTransaction): Promise<void> =>
      new Promise((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });

    const currentDatabases = typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : [];

    for (const database of state) {
      const currentVersion = currentDatabases.find((current) => current.name === database.name)?.version ?? 0;
      const version = Math.max(database.version, currentVersion, 1);
      const request = indexedDB.open(database.name, version);
      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        for (const store of database.stores) {
          if (db.objectStoreNames.contains(store.name)) continue;
          const keyPath = store.keyPathArray === undefined
            ? store.keyPath
            : [...store.keyPathArray];
          const options: IDBObjectStoreParameters = {
            autoIncrement: store.autoIncrement,
            ...(keyPath === undefined ? {} : { keyPath }),
          };
          const objectStore = db.createObjectStore(store.name, options);
          for (const index of store.indexes) {
            const indexKeyPath = index.keyPathArray === undefined
              ? index.keyPath
              : [...index.keyPathArray];
            if (indexKeyPath === undefined) continue;
            objectStore.createIndex(index.name, indexKeyPath, {
              multiEntry: index.multiEntry,
              unique: index.unique,
            });
          }
        }
      });
      const db = await requestResult(request);
      const storeNames = database.stores
        .map((store) => store.name)
        .filter((name) => db.objectStoreNames.contains(name));
      if (storeNames.length === 0) {
        db.close();
        continue;
      }
      const transaction = db.transaction(storeNames, "readwrite");
      const requests: Array<Promise<unknown>> = [];
      for (const store of database.stores) {
        if (!db.objectStoreNames.contains(store.name)) continue;
        const objectStore = transaction.objectStore(store.name);
        requests.push(requestResult(objectStore.clear()));
        for (const record of store.records) {
          const value = record.value !== undefined
            ? decode(record.value)
            : decode(record.valueEncoded);
          const key = record.key !== undefined
            ? decode(record.key)
            : decode(record.keyEncoded);
          if (store.keyPath === undefined && store.keyPathArray === undefined) {
            if (!isValidKey(key)) throw new Error(`IndexedDB record in ${store.name} has an invalid key`);
            requests.push(requestResult(objectStore.put(value, key)));
          } else {
            requests.push(requestResult(objectStore.put(value)));
          }
        }
      }
      await Promise.all(requests);
      await transactionResult(transaction);
      db.close();
    }
    return true;
  }, databases), options);
}
async function restoreOriginStorage(
  page: Page,
  origin: BrowserStorageState["origins"][number],
  options?: CommandExecutionOptions,
): Promise<boolean> {
  const idbSupported = origin.indexedDB.length === 0
    || await withOperationTimeout(() => page.evaluate(() => typeof indexedDB !== "undefined"), options);
  if (!idbSupported) return false;
  await withOperationTimeout(() => page.evaluate((entries) => {
    window.localStorage.clear();
    for (const entry of entries) window.localStorage.setItem(entry.name, entry.value);
  }, origin.localStorage), options);
  return restoreIndexedDb(page, origin.indexedDB, options);
}


function isWaitAction(action: BrowserCommand["action"] | undefined): boolean {
  return action === "wait"
    || action === "waitforurl"
    || action === "waitforloadstate"
    || action === "waitforfunction"
    || action === "waitfordownload";
}

// Keep inner Playwright timeouts ahead of the outer ws-server deadline race.
// Invariant: inner timeout + guard <= outer command budget. The guard must
// exceed normal CDP round-trip jitter so a handled TimeoutError can reach the
// client before the outer fallback closes a genuinely unresponsive session.
const CDP_DEADLINE_GUARD_MS = 100;

function operationTimeout(
  options: CommandExecutionOptions | undefined,
  requested?: number,
): number | undefined {
  if (options === undefined) return requested;
  const remaining = Math.max(1, options.deadline - Date.now() - CDP_DEADLINE_GUARD_MS);
  return requested === undefined ? remaining : Math.min(requested, remaining);
}

const CDP_OBSERVER_BUDGET_MS = 500;

function cdpObserverOptions(
  options: CommandExecutionOptions | undefined,
): CommandExecutionOptions | undefined {
  const now = Date.now();
  const deadline = Math.min(options?.deadline ?? now + CDP_OBSERVER_BUDGET_MS, now + CDP_OBSERVER_BUDGET_MS);
  if (deadline <= now + CDP_DEADLINE_GUARD_MS) return undefined;
  return {
    deadline,
    budget: options === undefined
      ? deadline - now
      : Math.max(1, Math.min(options.budget, deadline - now)),
  };
}

class OperationTimeoutError extends Error {
  constructor() {
    super("Operation exceeded the remaining command deadline");
    this.name = "TimeoutError";
  }
}

function withOperationTimeout<T>(
  start: () => Promise<T>,
  options: CommandExecutionOptions | undefined,
): Promise<T> {
  const timeout = operationTimeout(options);
  let operation: Promise<T>;
  try {
    operation = start();
  } catch (error) {
    return Promise.reject(error);
  }
  if (timeout === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError()), timeout);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function normalizedUserAgentVersion(userAgent: string): string {
  return userAgent.replace(/_/g, ".");
}

function userAgentMetadataFor(
  userAgent: string,
  mobile: boolean,
): UserAgentMetadata {
  const chromeVersion = /(?:Chrome|Chromium|CriOS)\/([0-9.]+)/.exec(userAgent)?.[1] ?? "";
  const majorVersion = chromeVersion.split(".")[0] ?? "";
  const brands = chromeVersion === ""
    ? []
    : [
        { brand: "Not_A Brand", version: "99" },
        { brand: "Chromium", version: majorVersion },
        { brand: "Google Chrome", version: majorVersion },
      ];
  const fullVersionList = chromeVersion === ""
    ? []
    : [
        { brand: "Not_A Brand", version: "99.0.0.0" },
        { brand: "Chromium", version: chromeVersion },
        { brand: "Google Chrome", version: chromeVersion },
      ];
  const iosVersion = /(?:iPhone|CPU) OS ([0-9_]+)/.exec(userAgent)?.[1];
  const androidVersion = /Android ([^;)]+)/.exec(userAgent)?.[1];
  const windowsVersion = /Windows NT ([0-9.]+)/.exec(userAgent)?.[1];
  const macVersion = /Mac OS X ([0-9_]+)/.exec(userAgent)?.[1];
  const platform = iosVersion !== undefined
    ? "iOS"
    : androidVersion !== undefined
      ? "Android"
      : windowsVersion !== undefined
        ? "Windows"
        : macVersion !== undefined
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  const platformVersion = iosVersion !== undefined
    ? normalizedUserAgentVersion(iosVersion)
    : androidVersion
      ?? windowsVersion
      ?? (macVersion === undefined ? "" : normalizedUserAgentVersion(macVersion));
  const model = /Android [^;]+; ([^;)]+?)(?: Build\/[^;)]+)?[;)]/.exec(userAgent)?.[1]
    ?? (iosVersion === undefined ? "" : /iPad|iPhone|iPod/.exec(userAgent)?.[0] ?? "");
  const architecture = /(?:x86_64|x64)/.test(userAgent)
    ? "x86"
    : /(?:arm64|aarch64)/.test(userAgent)
      ? "arm"
      : "";
  return {
    brands,
    fullVersionList,
    platform,
    platformVersion,
    architecture,
    model,
    mobile,
  };
}

function normalizeDeviceDescriptor(name: string): DeviceDescriptor | undefined {
  const descriptor = devices[name];
  if (!descriptor) return undefined;
  const screen = descriptor.viewport;
  return {
    name,
    userAgent: descriptor.userAgent,
    userAgentMetadata: userAgentMetadataFor(descriptor.userAgent, descriptor.isMobile),
    viewport: {
      width: descriptor.viewport.width,
      height: descriptor.viewport.height,
    },
    screen: {
      width: screen.width,
      height: screen.height,
    },
    deviceScaleFactor: descriptor.deviceScaleFactor,
    isMobile: descriptor.isMobile,
    hasTouch: descriptor.hasTouch,
  };
}

function availableDeviceDescriptors(): ReadonlyArray<DeviceDescriptor> {
  return Object.keys(devices)
    .map((name) => normalizeDeviceDescriptor(name))
    .filter((descriptor): descriptor is DeviceDescriptor => descriptor !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function unknownDeviceError(name: string): ControllerError {
  return {
    _tag: "ValidationFailed",
    message: `Unknown device: ${name}; run \`moat device list\` to list available remote Chromium descriptors`,
  };
}

async function applySessionEmulation(
  context: BrowserContext,
  page: Page,
  runtimeState: SessionRuntimeState,
  emulation: SessionEmulation,
  options: CommandExecutionOptions | undefined,
): Promise<void> {
  let descriptor: DeviceDescriptor | undefined;
  let viewport: ViewportOverride | undefined;
  switch (emulation._tag) {
    case "DefaultEmulation":
      return;
    case "ViewportEmulation":
      viewport = emulation.viewport;
      break;
    case "DeviceEmulation":
      descriptor = emulation.descriptor;
      viewport = emulation.viewport;
      break;
    default:
      return exhaustive(emulation);
  }

  const existing = runtimeState.environmentPageSessions.get(page);
  const cdp = existing ?? await withOperationTimeout(
    () => context.newCDPSession(page),
    options,
  );
  if (existing === undefined) {
    runtimeState.environmentPageSessions.set(page, cdp);
    runtimeState.environmentSessions.add(cdp);
  }

  // Playwright's setViewportSize() re-applies a desktop viewport and resets
  // the CDP scale factor. Keep all emulation in one raw CDP application.
  // A mobile descriptor intentionally keeps mobile:true. Pages without a
  // viewport meta tag then expose Chromium's standards-defined 980 CSS-pixel
  // layout viewport; pages declaring width=device-width expose the descriptor
  // viewport dimensions.
  const metrics = descriptor === undefined
    ? {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
      }
    : {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: descriptor.isMobile,
        screenWidth: descriptor.screen.width,
        screenHeight: descriptor.screen.height,
      };
  await withOperationTimeout(
    () => cdp.send("Emulation.setDeviceMetricsOverride", metrics),
    options,
  );
  if (descriptor !== undefined) {
    await withOperationTimeout(
      () => cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: descriptor.hasTouch,
      }),
      options,
    );
    await withOperationTimeout(
      () => cdp.send("Network.setUserAgentOverride", {
        userAgent: descriptor.userAgent,
        userAgentMetadata: {
          ...descriptor.userAgentMetadata,
          brands: [...descriptor.userAgentMetadata.brands],
          fullVersionList: [...descriptor.userAgentMetadata.fullVersionList],
        },
      }),
      options,
    );
  }
}

async function applySessionPageEnvironment(
  context: BrowserContext,
  page: Page,
  runtimeState: SessionRuntimeState,
  environment: SessionEnvironmentSettings,
  options: CommandExecutionOptions | undefined,
): Promise<void> {
  await applySessionEmulation(context, page, runtimeState, environment.emulation, options);
  switch (environment.headers._tag) {
    case "Unset":
      break;
    case "Set": {
      const headers = environment.headers.value;
      await withOperationTimeout(
        () => page.setExtraHTTPHeaders(headers),
        options,
      );
      break;
    }
    default:
      return exhaustive(environment.headers);
  }
  switch (environment.media._tag) {
    case "Unset":
      return;
    case "Set": {
      const media = environment.media.value;
      await withOperationTimeout(
        () => page.emulateMedia(media),
        options,
      );
      return;
    }
    default:
      return exhaustive(environment.media);
  }
}

async function applySessionEnvironmentToNewPage(
  context: BrowserContext,
  page: Page,
  runtimeState: SessionRuntimeState,
  environment: SessionEnvironmentSettings,
  options: CommandExecutionOptions | undefined,
): Promise<void> {
  switch (environment.offline._tag) {
    case "Unset":
      break;
    case "Set": {
      const offline = environment.offline.value;
      await withOperationTimeout(
        () => context.setOffline(offline),
        options,
      );
      break;
    }
    default:
      return exhaustive(environment.offline);
  }
  await applySessionPageEnvironment(context, page, runtimeState, environment, options);
}

async function applySessionPageEnvironmentToAll(
  context: BrowserContext,
  runtimeState: SessionRuntimeState,
  environment: SessionEnvironmentSettings,
  options: CommandExecutionOptions | undefined,
): Promise<void> {
  for (const target of context.pages()) {
    await applySessionPageEnvironment(context, target, runtimeState, environment, options);
  }
}

async function reapplySessionPageEnvironment(
  context: BrowserContext,
  page: Page,
  runtimeState: SessionRuntimeState,
  options: CommandExecutionOptions | undefined,
): Promise<void> {
  await applySessionPageEnvironment(context, page, runtimeState, runtimeState.environment, options);
  runtimeState.environmentPages.add(page);
}



function timeoutError(
  action: BrowserCommand["action"],
  options: CommandExecutionOptions,
): ControllerError {
  return {
    _tag: "Timeout",
    operation: `${action} exceeded ${options.budget}ms (result may include partial side effects)`,
  };
}

function mapPlaywrightError(
  e: unknown,
  action?: BrowserCommand["action"],
  options?: CommandExecutionOptions,
): ControllerError {
  if (!(e instanceof Error)) {
    return { _tag: "CommandFailed", message: String(e) };
  }

  const msg = e.message;

  if (e.name === "TimeoutError" || msg.includes("Timeout")) {
    if (!isWaitAction(action) && (msg.includes("waiting for locator") || msg.includes("waiting for selector"))) {
      return { _tag: "ElementNotFound", selector: undefined };
    }
    const budget = options === undefined ? "" : ` (budget ${options.budget}ms)`;
    return { _tag: "Timeout", operation: `${action ?? "operation"}: ${msg}${budget}` };
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
  options?: CommandExecutionOptions,
): Promise<Result<CommandResultData, ControllerError>> {
  if (options !== undefined && options.deadline <= Date.now()) {
    return err(timeoutError(command.action, options));
  }
  if (command.action === "device" && normalizeDeviceDescriptor(command.device) === undefined) {
    return err(unknownDeviceError(command.device));
  }
  const runtimeState = observeContextRuntime(sessionId, context);
  let activeTabIndex = sessionTabIndex.get(sessionId) ?? 0;
  const page = context.pages()[activeTabIndex] ?? context.pages()[0];
  runtimeState.activePage = page;
  await ensureCdpRuntimeObserver(sessionId, context, page, options);
  const scope = runtimeState.activeFrame ?? page;
  const refScope = currentRefScope(runtimeState, page);

  try {
    if (!runtimeState.environmentPages.has(page)) {
      await applySessionPageEnvironment(context, page, runtimeState, runtimeState.environment, options);
      runtimeState.environmentPages.add(page);
    }
    switch (command.action) {
      case "navigate": {
        invalidateRefs(refStore, sessionId, "navigation");
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        if (command.headers) {
          const headers = runtimeState.environment.headers._tag === "Set"
            ? { ...runtimeState.environment.headers.value, ...command.headers }
            : command.headers;
          await withOperationTimeout(
            () => page.setExtraHTTPHeaders(headers),
            options,
          );
        }
        const timeout = operationTimeout(options);
        await page.goto(command.url, {
          waitUntil: command.waitUntil === "none" ? "commit" : (command.waitUntil ?? "domcontentloaded"),
          ...(timeout === undefined ? {} : { timeout }),
        });
        await reapplySessionPageEnvironment(context, page, runtimeState, options);
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }

      case "back": {
        invalidateRefs(refStore, sessionId, "navigation");
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const timeout = operationTimeout(options);
        const response = await page.goBack({
          waitUntil: "domcontentloaded",
          ...(timeout === undefined ? {} : { timeout }),
        });
        if (response === null) {
          return err({ _tag: "CommandFailed", message: "No back history" } as const);
        }
        await reapplySessionPageEnvironment(context, page, runtimeState, options);
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }
      case "forward": {
        invalidateRefs(refStore, sessionId, "navigation");
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const timeout = operationTimeout(options);
        const response = await page.goForward({
          waitUntil: "domcontentloaded",
          ...(timeout === undefined ? {} : { timeout }),
        });
        if (response === null) {
          return err({ _tag: "CommandFailed", message: "No forward history" } as const);
        }
        await reapplySessionPageEnvironment(context, page, runtimeState, options);
        const result: NavigateResult = { _tag: "NavigateResult", url: page.url(), title: await page.title() };
        return ok(result);
      }
      case "reload": {
        invalidateRefs(refStore, sessionId, "navigation");
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const timeout = operationTimeout(options);
        await page.reload({
          waitUntil: "domcontentloaded",
          ...(timeout === undefined ? {} : { timeout }),
        });
        await reapplySessionPageEnvironment(context, page, runtimeState, options);
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
        return executeLocatorAction(loc, command.subaction, runtimeState, command.value, options);
      }

      case "getbylabel":
        return executeLocatorAction(
          scope.getByLabel(command.label, { exact: command.exact }),
          command.subaction, runtimeState, command.value, options,
        );

      case "getbyplaceholder":
        return executeLocatorAction(
          scope.getByPlaceholder(command.placeholder, { exact: command.exact }),
          command.subaction, runtimeState, command.value, options,
        );

      case "getbytext":
        return executeLocatorAction(
          scope.getByText(command.text, { exact: command.exact }),
          command.subaction, runtimeState, undefined, options,
        );

      case "getbyalttext":
        return executeLocatorAction(
          scope.getByAltText(command.text, { exact: command.exact }),
          command.subaction, runtimeState, undefined, options,
        );

      case "getbytitle":
        return executeLocatorAction(
          scope.getByTitle(command.text, { exact: command.exact }),
          command.subaction, runtimeState, undefined, options,
        );

      case "getbytestid":
        return executeLocatorAction(
          scope.getByTestId(command.testId),
          command.subaction, runtimeState, command.value, options,
        );

      case "click": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        if (command.newTab) {
          const resolved = resolveLocator(
            scope,
            refStore,
            sessionId,
            refScope,
            command.ref,
            command.selector,
          );
          if (resolved._tag === "Err") return resolved;
          return executeNewTabClick(context, page, resolved.value, sessionId, runtimeState, options);
        }
        return executeElementAction(
          scope,
          refStore,
          sessionId,
          refScope,
          command.ref,
          command.selector,
          "click",
          runtimeState,
          undefined,
          options,
        );
      }

      case "fill":
        return executeElementAction(
          scope,
          refStore,
          sessionId,
          refScope,
          command.ref,
          command.selector,
          "fill",
          runtimeState,
          command.value,
          options,
        );

      case "type":
        return executeElementAction(
          scope,
          refStore,
          sessionId,
          refScope,
          command.ref,
          command.selector,
          "type",
          runtimeState,
          command.text,
          options,
        );

      case "hover":
        return executeElementAction(
          scope,
          refStore,
          sessionId,
          refScope,
          command.ref,
          command.selector,
          "hover",
          runtimeState,
          undefined,
          options,
        );
      case "snapshot": {
        const snapshotResult = await buildAriaSnapshot(scope, refStore, sessionId, refScope, command);
        if (snapshotResult._tag === "Err") return snapshotResult;
        const result: SnapshotResult = { _tag: "SnapshotResult", snapshot: snapshotResult.value };
        return ok(result);
      }

      case "screenshot": {
        const format = command.format ?? "png";
        const screenshotOptions = {
          type: format,
          quality: format === "jpeg" ? (command.quality ?? 80) : undefined,
        } as const;
        let target: Locator | undefined;
        if (command.ref) {
          const resolved = resolveRef(refStore, sessionId, command.ref, refScope);
          if (resolved._tag === "Err") return resolved;
          target = resolved.value;
        } else if (command.selector) {
          target = scope.locator(command.selector);
        }
        let annotations: ReadonlyArray<ScreenshotAnnotation> = [];
        if (command.annotate) {
          const annotationResult = await installScreenshotAnnotations(
            page,
            scope,
            refStore,
            sessionId,
            refScope,
          );
          if (annotationResult._tag === "Err") return annotationResult;
          annotations = annotationResult.value;
        }
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

      case "eval":
        return executeEvalWithDialog(sessionId, context, page, scope, command.code, options);

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
        const result: TabResult & { readonly activeFrame?: string } = {
          _tag: "TabResult",
          tabs: await buildTabList(context, activeTabIndex),
          ...(runtimeState.activeFrameSelector === undefined
            ? {}
            : { activeFrame: runtimeState.activeFrameSelector }),
        };
        return ok(result);
      }

      case "tab_new": {
        invalidateRefs(refStore, sessionId, "page");
        const newPage = await withOperationTimeout(
          () => context.newPage(),
          options,
        );
        observePageRuntime(sessionId, newPage);
        await ensureCdpRuntimeObserver(sessionId, context, newPage, options);
        await applySessionEnvironmentToNewPage(context, newPage, runtimeState, runtimeState.environment, options);
        runtimeState.environmentPages.add(newPage);
        if (command.url) {
          const timeout = operationTimeout(options);
          await newPage.goto(command.url, {
            ...(timeout === undefined ? {} : { timeout }),
          });
        }
        if (command.url) {
          await reapplySessionPageEnvironment(context, newPage, runtimeState, options);
        }
        activeTabIndex = context.pages().length - 1;
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activePage = newPage;
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_switch": {
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= context.pages().length) {
          return err({ _tag: "ElementNotFound", selector: `tab:${command.index}` });
        }
        const nextPage = context.pages()[command.index];
        if (nextPage !== page) {
          invalidateRefs(refStore, sessionId, "page");
        } else if (runtimeState.activeFrame !== undefined) {
          invalidateRefs(refStore, sessionId, "frame");
        }
        activeTabIndex = command.index;
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activePage = nextPage;
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        observePageRuntime(sessionId, nextPage);
        await ensureCdpRuntimeObserver(sessionId, context, nextPage, options);
        const result: TabResult = { _tag: "TabResult", tabs: await buildTabList(context, activeTabIndex) };
        return ok(result);
      }

      case "tab_close": {
        const closeIndex = command.index ?? activeTabIndex;
        const pages = context.pages();
        if (!Number.isInteger(closeIndex) || closeIndex < 0 || closeIndex >= pages.length) {
          return err({ _tag: "ElementNotFound", selector: `tab:${closeIndex}` });
        }
        const closingActivePage = closeIndex === activeTabIndex;
        await pages[closeIndex].close();
        if (closingActivePage) {
          invalidateRefs(refStore, sessionId, "page");
          const remainingPages = context.pages();
          if (activeTabIndex >= remainingPages.length) {
            activeTabIndex = Math.max(0, remainingPages.length - 1);
          }
          runtimeState.activePage = remainingPages[activeTabIndex];
          runtimeState.activeFrame = undefined;
          runtimeState.activeFrameSelector = undefined;
          observePageRuntime(sessionId, remainingPages[activeTabIndex]);
          await ensureCdpRuntimeObserver(sessionId, context, remainingPages[activeTabIndex], options);
        } else if (closeIndex < activeTabIndex) {
          activeTabIndex--;
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
        const timeout = operationTimeout(options, command.timeout);
        if (command.selector) {
          const state = (command.state ?? "visible") as "visible" | "hidden" | "attached" | "detached";
          await scope.locator(command.selector).waitFor({ state, timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "selector" };
          return ok(wr);
        }
        if (command.text) {
          await scope.getByText(command.text).waitFor({ timeout });
          const wr: WaitResult = { _tag: "WaitResult", waited: "text" };
          return ok(wr);
        }
        const duration = command.time ?? 1000;
        if (options === undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, duration));
        } else {
          const remaining = options.deadline - Date.now();
          if (remaining <= 0) return err(timeoutError(command.action, options));
          if (duration > remaining) {
            await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            return err(timeoutError(command.action, options));
          }
          await new Promise<void>((resolve) => setTimeout(resolve, duration));
          if (options.deadline <= Date.now()) return err(timeoutError(command.action, options));
        }
        const wr: WaitResult = { _tag: "WaitResult", waited: "timeout" };
        return ok(wr);
      }

      case "waitforurl": {
        await scope.waitForURL(command.url, { timeout: operationTimeout(options, command.timeout) });
        const wr: WaitResult = { _tag: "WaitResult", waited: "url", url: page.url() };
        return ok(wr);
      }

      case "waitforloadstate": {
        const state = command.state as "load" | "domcontentloaded" | "networkidle";
        await scope.waitForLoadState(state, { timeout: operationTimeout(options, command.timeout) });
        const wr: WaitResult = { _tag: "WaitResult", waited: "loadstate", state: command.state };
        return ok(wr);
      }

      case "waitforfunction": {
        const handle = await scope.waitForFunction(
          command.expression,
          undefined,
          { timeout: operationTimeout(options, command.timeout) },
        );
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

      case "evaluate":
        return executeEvalWithDialog(sessionId, context, page, scope, command.script, options);

      // ─── batch ───

      case "batch": {
        const entries: BatchResultEntry[] = [];
        for (const sub of command.commands) {
          const subResult = await executeCommand(context, sub, refStore, sessionId, options);
          if (subResult._tag === "Ok") {
            entries.push({ success: true, data: subResult.value });
          } else {
            if (subResult.error._tag === "Timeout") return subResult;
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

      case "dblclick": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        await scope.locator(command.selector).dblclick();
        return ok({ _tag: "VoidResult" } as const);
      }

      case "check": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        await scope.locator(command.selector).check();
        return ok({ _tag: "VoidResult" } as const);
      }

      case "uncheck": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        await scope.locator(command.selector).uncheck();
        return ok({ _tag: "VoidResult" } as const);
      }

      case "select": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        const values = Array.isArray(command.values) ? command.values : [command.values];
        await scope.locator(command.selector).selectOption(values);
        return ok({ _tag: "VoidResult" } as const);
      }

      case "focus": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        await scope.locator(command.selector).focus();
        return ok({ _tag: "VoidResult" } as const);
      }

      case "keyboard": {
        const conflict = modifierConflict(runtimeState);
        if (conflict) return err(conflict);
        if (command.subaction === "type") {
          await page.keyboard.type(command.text);
        } else {
          await page.keyboard.insertText(command.text);
        }
        return ok({ _tag: "VoidResult" } as const);
      }

      case "keydown":
        await page.keyboard.down(command.key);
        if (MODIFIER_KEYS[command.key] === true) {
          runtimeState.heldModifiers.add(command.key);
        }
        return ok(keyStateResult(runtimeState));

      case "keyup":
        await page.keyboard.up(command.key);
        runtimeState.heldModifiers.delete(command.key);
        return ok(keyStateResult(runtimeState));

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

      case "highlight":
        await scope.locator(command.selector).highlight();
        return ok({ _tag: "VoidResult" } as const);

      case "viewport": {
        const viewport: ViewportOverride = {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor ?? 1,
        };
        const emulation: SessionEmulation = runtimeState.environment.emulation._tag === "DeviceEmulation"
          ? { ...runtimeState.environment.emulation, viewport }
          : { _tag: "ViewportEmulation", viewport };
        const environment: SessionEnvironmentSettings = {
          ...runtimeState.environment,
          emulation,
        };
        await applySessionPageEnvironmentToAll(context, runtimeState, environment, options);
        for (const target of context.pages()) runtimeState.environmentPages.add(target);
        runtimeState.environment = environment;
        return ok({ _tag: "VoidResult" } as const);
      }

      case "device": {
        const descriptor = normalizeDeviceDescriptor(command.device);
        if (descriptor === undefined) {
          return err(unknownDeviceError(command.device));
        }
        const viewport: ViewportOverride = {
          width: descriptor.viewport.width,
          height: descriptor.viewport.height,
          deviceScaleFactor: descriptor.deviceScaleFactor,
        };
        const environment: SessionEnvironmentSettings = {
          ...runtimeState.environment,
          emulation: { _tag: "DeviceEmulation", descriptor, viewport },
        };
        await applySessionPageEnvironmentToAll(context, runtimeState, environment, options);
        for (const target of context.pages()) runtimeState.environmentPages.add(target);
        runtimeState.environment = environment;
        return ok({ _tag: "VoidResult" } as const);
      }

      case "geolocation":
        await context.grantPermissions(["geolocation"]);
        await context.setGeolocation({ latitude: command.latitude, longitude: command.longitude });
        return ok({ _tag: "VoidResult" } as const);

      case "offline":
        await withOperationTimeout(
          () => context.setOffline(command.offline),
          options,
        );
        runtimeState.environment = {
          ...runtimeState.environment,
          offline: { _tag: "Set", value: command.offline },
        };
        return ok({ _tag: "VoidResult" } as const);

      case "headers": {
        const environment: SessionEnvironmentSettings = {
          ...runtimeState.environment,
          headers: { _tag: "Set", value: { ...command.headers } },
        };
        await applySessionPageEnvironmentToAll(context, runtimeState, environment, options);
        for (const target of context.pages()) runtimeState.environmentPages.add(target);
        runtimeState.environment = environment;
        return ok({ _tag: "VoidResult" } as const);
      }

      case "credentials":
        await context.setHTTPCredentials({ username: command.username, password: command.password });
        return ok({ _tag: "VoidResult" } as const);

      case "emulatemedia": {
        const environment: SessionEnvironmentSettings = {
          ...runtimeState.environment,
          media: {
            _tag: "Set",
            value: {
              colorScheme: command.colorScheme,
              reducedMotion: command.reducedMotion,
            },
          },
        };
        await applySessionPageEnvironmentToAll(context, runtimeState, environment, options);
        for (const target of context.pages()) runtimeState.environmentPages.add(target);
        runtimeState.environment = environment;
        return ok({ _tag: "VoidResult" } as const);
      }


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

      case "route":
        await page.route(command.url, async (route) => {
          if (command.abort) {
            await route.abort();
          } else if (command.body !== undefined) {
            await route.fulfill({ body: command.body, contentType: "application/json" });
          } else {
            await route.continue();
          }
        });
        return ok({ _tag: "VoidResult" } as const);

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

      case "window_new": {
        invalidateRefs(refStore, sessionId, "page");
        const newPage = await withOperationTimeout(
          () => context.newPage(),
          options,
        );
        observePageRuntime(sessionId, newPage);
        await ensureCdpRuntimeObserver(sessionId, context, newPage, options);
        await applySessionEnvironmentToNewPage(context, newPage, runtimeState, runtimeState.environment, options);
        runtimeState.environmentPages.add(newPage);
        activeTabIndex = context.pages().indexOf(newPage);
        sessionTabIndex.set(sessionId, activeTabIndex);
        runtimeState.activePage = newPage;
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const r: TabResult = {
          _tag: "TabResult",
          tabs: await buildTabList(context, activeTabIndex),
        };
        return ok(r);
      }

      case "nth": {
        const loc = scope.locator(command.selector);
        const count = await loc.count();
        const index = command.index === -1 ? count - 1 : command.index;
        if (
          !Number.isInteger(command.index)
          || command.index < -1
          || index < 0
          || index >= count
        ) {
          return err({ _tag: "ElementNotFound", selector: command.selector });
        }
        if (command.subaction === undefined) {
          const result: LocatorResult = { _tag: "LocatorResult", found: true, count };
          return ok(result);
        }

        const target = loc.nth(index);
        const subaction = command.subaction;
        if (
          command.value === undefined
          && (subaction === "fill" || subaction === "type" || subaction === "select")
        ) {
          return err({
            _tag: "ValidationFailed",
            message: `nth ${subaction} requires a value`,
          });
        }
        return executeLocatorAction(target, subaction, runtimeState, command.value, options);
      }

      case "upload":
        await scope.locator(command.selector).setInputFiles(command.files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.base64, "base64"),
        })));
        return ok({ _tag: "VoidResult" } as const);

      case "download": {
        const resolved = resolveLocator(scope, refStore, sessionId, refScope, command.ref, command.selector);
        if (resolved._tag === "Err") return resolved;
        return ok(await remoteDownload(
          context,
          page,
          sessionId,
          operationTimeout(options),
          () => resolved.value.click(),
        ));
      }

      case "waitfordownload": {
        return ok(await remoteDownload(
          context,
          page,
          sessionId,
          operationTimeout(options, command.timeout),
        ));
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

      case "device_list": {
        const result: DeviceListResult = {
          _tag: "DeviceListResult",
          devices: availableDeviceDescriptors(),
        };
        return ok(result);
      }

      case "state_save": {
        const playwrightState: StorageState = await withOperationTimeout(
          () => context.storageState({ indexedDB: true }),
          options,
        );
        const tabs = await Promise.all(context.pages().map(async (statePage) => ({
          url: statePage.url(),
          sessionStorage: await withOperationTimeout(() => statePage.evaluate(() =>
            Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
              .filter((name): name is string => name !== null)
              .map((name) => ({ name, value: sessionStorage.getItem(name) ?? "" })),
          ), options),
        })));
        const localOrigins = new Map(playwrightState.origins.map((entry) => [entry.origin, entry]));
        const originsByPage = tabs
          .map((tab) => stateOrigin(tab.url))
          .filter((origin): origin is string => origin !== undefined);
        const origins = [...new Set([...localOrigins.keys(), ...originsByPage])].map((origin) => {
          const stored = localOrigins.get(origin);
          return {
            origin,
            localStorage: stored?.localStorage ?? [],
            indexedDB: stored?.indexedDB ?? [],
          };
        });
        const state: BrowserStorageState = {
          schemaVersion: 2,
          cookies: playwrightState.cookies,
          origins,
          tabs,
        };
        const bytes = Buffer.from(JSON.stringify(state));
        const r: BinaryFileResult = {
          _tag: "BinaryFileResult",
          base64: bytes.toString("base64"),
          suggestedFilename: "state.json",
        };
        return ok(r);
      }

      case "state_load": {
        const counts = stateLoadCounts(command.state);
        const pages = context.pages();
        const tabTargets: StatePageTarget[] = [];
        for (const tab of command.state.tabs) {
          const matches = pages.filter((candidate) => candidate.url() === tab.url);
          if (matches.length === 0) {
            const r: StateLoadResult = {
              _tag: "StateLoadResult",
              status: "incomplete",
              reason: "missing_tab",
              ...counts,
            };
            return ok(r);
          }
          if (matches.length > 1) {
            const r: StateLoadResult = {
              _tag: "StateLoadResult",
              status: "incomplete",
              reason: "ambiguous_tab",
              ...counts,
            };
            return ok(r);
          }
          tabTargets.push({ page: matches[0] });
        }

        const originTargets: Array<readonly [BrowserStorageState["origins"][number], Page]> = [];
        for (const origin of command.state.origins) {
          const matches = pages.filter((candidate) => stateOrigin(candidate.url()) === origin.origin);
          if (matches.length === 0) {
            const r: StateLoadResult = {
              _tag: "StateLoadResult",
              status: "incomplete",
              reason: "missing_origin",
              ...counts,
            };
            return ok(r);
          }
          originTargets.push([origin, matches[0]]);
        }

        for (const [origin, originPage] of originTargets) {
          if (origin.indexedDB.length === 0) continue;
          const supported = await withOperationTimeout(
            () => originPage.evaluate(() => typeof indexedDB !== "undefined"),
            options,
          );
          if (!supported) {
            const r: StateLoadResult = {
              _tag: "StateLoadResult",
              status: "unsupported",
              reason: "indexeddb",
              ...counts,
            };
            return ok(r);
          }
        }

        await withOperationTimeout(() => context.addCookies(command.state.cookies), options);
        for (const [origin, originPage] of originTargets) {
          const restored = await restoreOriginStorage(originPage, origin, options);
          if (!restored) {
            const r: StateLoadResult = {
              _tag: "StateLoadResult",
              status: "unsupported",
              reason: "indexeddb",
              ...counts,
            };
            return ok(r);
          }
        }
        for (let index = 0; index < tabTargets.length; index += 1) {
          const target = tabTargets[index];
          const stateTab = command.state.tabs[index];
          if (!target || !stateTab) continue;
          await withOperationTimeout(() => target.page.evaluate((entries) => {
            window.sessionStorage.clear();
            for (const entry of entries) window.sessionStorage.setItem(entry.name, entry.value);
          }, stateTab.sessionStorage), options);
        }
        const r: StateLoadResult = {
          _tag: "StateLoadResult",
          status: "complete",
          loaded: true,
          ...counts,
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
          const timeout = operationTimeout(options, 30_000);
          const timer = setTimeout(
            () => reject(new Error("Profiler stop timed out")),
            timeout ?? 30_000,
          );
          cdp.once("Tracing.tracingComplete", (event) => {
            clearTimeout(timer);
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
        runtimeState.harActive = true;
        const r: StartedResult = { _tag: "StartedResult", started: true };
        return ok(r);
      }

      case "har_stop": {
        if (!runtimeState.harActive) {
          return err({ _tag: "CommandFailed", message: "No HAR recording in progress" });
        }
        runtimeState.harActive = false;
        const entries = [...runtimeState.requests.values()].map((request) => ({
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
            content: {
              size: request.responseBody?.length ?? 0,
              mimeType: request.responseHeaders?.["content-type"] ?? "",
              ...(request.responseBody === undefined ? {} : { text: request.responseBody }),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: request.responseBody?.length ?? 0,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        }));
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
        if (command.response === "result") {
          return operationDialogResult(runtimeState, command.operationId);
        }

        const target: DialogTarget = {
          ...(command.dialogId === undefined ? {} : { dialogId: command.dialogId }),
          ...(command.pageId === undefined ? {} : { pageId: command.pageId }),
        };
        if (command.response === "status") {
          const dialog = findDialog(runtimeState, page, target);
          if (dialog === undefined) {
            return err({ _tag: "ElementNotFound", selector: "dialog" });
          }
          return ok(dialogResultFor(runtimeState, context, dialog, "open"));
        }

        let dialog = findDialog(runtimeState, page, target);
        if (dialog === undefined) {
          try {
            const observed = await page.waitForEvent("dialog", {
              timeout: operationTimeout(options) ?? 5_000,
            });
            dialog = findDialog(runtimeState, page, target)
              ?? registerDialog(sessionId, page, observed);
          } catch {
            return err({ _tag: "ElementNotFound", selector: "dialog" });
          }
        }
        const accepted = command.response === "accept";
        if (accepted) await dialog.dialog.accept(command.promptText);
        else await dialog.dialog.dismiss();
        removeDialog(runtimeState, dialog);

        let operation = dialogOperationFor(runtimeState, dialog.initiator);
        if (dialog.initiator._tag === "Eval") {
          const completion = runtimeState.evalPromises.get(dialog.initiator.operationId);
          if (completion !== undefined) {
            const settled = await operationCompletion(
              completion,
              operationTimeout(options) ?? DIALOG_HANDLER_GRACE_MS,
            );
            if (settled !== undefined) operation = dialogOperationFor(runtimeState, dialog.initiator);
          }
        }
        const result: DialogResult = {
          _tag: "DialogResult",
          state: "handled",
          hasDialog: false,
          handled: true,
          accepted,
          dialogId: dialog.dialogId,
          page: dialogPageFor(runtimeState, context, dialog.page),
          operation,
        };
        return ok(result);
      }

      case "frame": {
        const handle = await scope.locator(command.selector).elementHandle();
        if (!handle) return err({ _tag: "ElementNotFound", selector: command.selector });
        const frame = await handle.contentFrame();
        if (!frame) {
          return err({ _tag: "CommandFailed", message: `Selector is not a frame: ${command.selector}` });
        }
        invalidateRefs(refStore, sessionId, "frame");
        runtimeState.activeFrame = frame;
        runtimeState.activeFrameSelector = command.selector;
        const r: FrameResult = { _tag: "FrameResult", frame: command.selector };
        return ok(r);
      }

      case "mainframe": {
        invalidateRefs(refStore, sessionId, "frame");
        runtimeState.activeFrame = undefined;
        runtimeState.activeFrameSelector = undefined;
        const r: FrameResult = { _tag: "FrameResult", frame: "main" };
        return ok(r);
      }

      case "console": {
        if (command.clear) {
          runtimeState.consoleMessages.splice(0);
          const r: ClearedResult = { _tag: "ClearedResult", cleared: true };
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
    await releaseHeldModifiers(page, runtimeState);
    return err(mapPlaywrightError(e, command.action, options));
  }
}
