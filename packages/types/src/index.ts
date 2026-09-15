import { type } from "arktype";

// ─── exhaustive helper ───

export function exhaustive(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}

// ─── ContentBoundary ───

export type ContentBoundary = {
  readonly nonce: string;
  readonly origin: string;
};

// ─── CookieEntry ───

export type CookieEntry = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "Strict" | "Lax" | "None";
};

// ─── TabInfo ───

export type TabInfo = {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
};

// ─── CommandResultData ───

export type NavigateResult = {
  readonly _tag: "NavigateResult";
  readonly url: string;
  readonly title: string;
};

export type VoidResult = {
  readonly _tag: "VoidResult";
};

export type LocatorResult = {
  readonly _tag: "LocatorResult";
  readonly found: true;
  readonly count: number;
};

export type KeyStateResult = {
  readonly _tag: "KeyStateResult";
  readonly heldModifiers: ReadonlyArray<string>;
};

export type SnapshotResult = {
  readonly _tag: "SnapshotResult";
  readonly snapshot: string;
};

export type ScreenshotResult = {
  readonly _tag: "ScreenshotResult";
  readonly base64?: string;
  readonly path?: string;
  readonly size?: number;
  readonly format: "png" | "jpeg";
  readonly annotations?: ReadonlyArray<{
    readonly number: number;
    readonly ref: string;
    readonly role: string;
    readonly name: string;
  }>;
};

export type EvalResult = {
  readonly _tag: "EvalResult";
  readonly result: string;
};

export type TabResult = {
  readonly _tag: "TabResult";
  readonly tabs: ReadonlyArray<TabInfo>;
};

export type CookiesResult = {
  readonly _tag: "CookiesResult";
  readonly cookies: ReadonlyArray<CookieEntry>;
};

export type WaitResult = {
  readonly _tag: "WaitResult";
  readonly waited: string;
  readonly url?: string;
  readonly state?: string;
  readonly result?: string;
};

export type GetTextResult = {
  readonly _tag: "GetTextResult";
  readonly text: string;
};

export type GetValueResult = {
  readonly _tag: "GetValueResult";
  readonly value: string;
};

export type GetHtmlResult = {
  readonly _tag: "GetHtmlResult";
  readonly html: string;
};

export type PageUrlResult = {
  readonly _tag: "PageUrlResult";
  readonly url: string;
};

export type PageTitleResult = {
  readonly _tag: "PageTitleResult";
  readonly title: string;
};

export type CountResult = {
  readonly _tag: "CountResult";
  readonly count: number;
};

export type BoundingBoxResult = {
  readonly _tag: "BoundingBoxResult";
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
};

export type ElementStylesResult = {
  readonly _tag: "ElementStylesResult";
  readonly elements: ReadonlyArray<{
    readonly tag: string;
    readonly text: string;
    readonly box: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null;
    readonly styles: {
      readonly fontSize: string;
      readonly fontWeight: string;
      readonly fontFamily: string;
      readonly color: string;
      readonly backgroundColor: string;
      readonly borderRadius: string;
    };
  }>;
};

export type StorageResult = {
  readonly _tag: "StorageResult";
  readonly data?: Readonly<Record<string, string>>;
  readonly key?: string;
  readonly value?: string | null;
};

// ─── Browser diagnostics ───

export type DiagnosticContext = {
  readonly sessionId: string;
  readonly pageId: string;
  readonly frameId: string;
  readonly pageUrl: string;
  readonly frameUrl: string;
  /** Unix epoch milliseconds captured when the browser emitted the event. */
  readonly timestamp: number;
};

export type ConsoleDiagnostic = DiagnosticContext & {
  readonly _tag: "ConsoleDiagnostic";
  readonly type: string;
  readonly text: string;
};

export type PageErrorDiagnostic = DiagnosticContext & {
  readonly _tag: "PageErrorDiagnostic";
  readonly message: string;
};

export type ResourceFailureDiagnostic = DiagnosticContext & {
  readonly _tag: "ResourceFailureDiagnostic";
  readonly url: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly errorText?: string;
};

export type PolicyBlockedDiagnostic = DiagnosticContext & {
  readonly _tag: "PolicyBlockedDiagnostic";
  readonly url: string;
  readonly resourceType?: string;
  readonly policy: string;
  readonly text: string;
};

export type DiagnosticRecord =
  | ConsoleDiagnostic
  | PageErrorDiagnostic
  | ResourceFailureDiagnostic
  | PolicyBlockedDiagnostic;

export type ConsoleResult = {
  readonly _tag: "ConsoleResult";
  readonly messages: ReadonlyArray<DiagnosticRecord>;
};

export type PageErrorsResult = {
  readonly _tag: "PageErrorsResult";
  readonly errors: ReadonlyArray<DiagnosticRecord>;
};

export type ClearedResult = {
  readonly _tag: "ClearedResult";
  readonly cleared: true;
};

export type NetworkRequestEntry = {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly postData?: string;
  readonly status?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
};

export type NetworkRequestsResult = {
  readonly _tag: "NetworkRequestsResult";
  readonly requests: ReadonlyArray<NetworkRequestEntry>;
};

export type NetworkRequestDetailResult = {
  readonly _tag: "NetworkRequestDetailResult";
  readonly request: NetworkRequestEntry;
};

export type BinaryFileResult = {
  readonly _tag: "BinaryFileResult";
  readonly base64: string;
  readonly suggestedFilename?: string;
  readonly eventCount?: number;
  readonly requestCount?: number;
};

export type StartedResult = {
  readonly _tag: "StartedResult";
  readonly started: true;
};

export type ClipboardResult = {
  readonly _tag: "ClipboardResult";
  readonly text?: string;
  readonly written?: string;
  readonly copied?: true;
  readonly pasted?: true;
};

export type DialogType = "alert" | "beforeunload" | "confirm" | "prompt" | "unknown";

export type DialogPage = {
  readonly pageId: string;
  readonly pageIndex: number;
  readonly pageUrl: string;
};

export type DialogOperation =
  | { readonly _tag: "NoOperation" }
  | { readonly _tag: "PendingOperation"; readonly operationId: string }
  | {
      readonly _tag: "SettledOperation";
      readonly operationId: string;
      readonly result: EvalResult;
    }
  | {
      readonly _tag: "FailedOperation";
      readonly operationId: string;
      readonly error: string;
    }
  | {
      readonly _tag: "TimedOutOperation";
      readonly operationId: string;
      readonly operation: string;
    };

export type DialogResult =
  | {
      readonly _tag: "DialogResult";
      readonly state: "idle";
      readonly hasDialog: false;
    }
  | {
      readonly _tag: "DialogResult";
      readonly state: "open" | "pending";
      readonly hasDialog: true;
      readonly dialogId: string;
      readonly page: DialogPage;
      readonly type: DialogType;
      readonly message: string;
      readonly defaultPrompt: string;
      readonly operation: DialogOperation;
    }
  | {
      readonly _tag: "DialogResult";
      readonly state: "handled";
      readonly hasDialog: false;
      readonly handled: true;
      readonly accepted: boolean;
      readonly dialogId: string;
      readonly page: DialogPage;
      readonly operation: DialogOperation;
    }
  | {
      readonly _tag: "DialogResult";
      readonly state: "operation";
      readonly hasDialog: false;
      readonly operationId: string;
      readonly operation: DialogOperation;
    };

export type FrameResult = {
  readonly _tag: "FrameResult";
  readonly frame: string;
};

export type CdpUrlResult = {
  readonly _tag: "CdpUrlResult";
  readonly cdpUrl: string;
};

export type TouchResult = {
  readonly _tag: "TouchResult";
  readonly tapped?: string;
  readonly swiped?: "up" | "down" | "left" | "right";
};
export type UserAgentBrand = {
  readonly brand: string;
  readonly version: string;
};

export type UserAgentMetadata = {
  readonly brands: ReadonlyArray<UserAgentBrand>;
  readonly fullVersionList: ReadonlyArray<UserAgentBrand>;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
};

export type DeviceDescriptor = {
  readonly name: string;
  readonly userAgent: string;
  readonly userAgentMetadata: UserAgentMetadata;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly screen: {
    readonly width: number;
    readonly height: number;
  };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
};

export type DeviceListResult = {
  readonly _tag: "DeviceListResult";
  readonly devices: ReadonlyArray<DeviceDescriptor>;
};

export type ViewportOverride = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
};

export type SessionSetting<T> =
  | { readonly _tag: "Unset" }
  | { readonly _tag: "Set"; readonly value: T };

export type SessionEmulation =
  | { readonly _tag: "DefaultEmulation" }
  | { readonly _tag: "ViewportEmulation"; readonly viewport: ViewportOverride }
  | {
      readonly _tag: "DeviceEmulation";
      readonly descriptor: DeviceDescriptor;
      readonly viewport: ViewportOverride;
    };

export type SessionEnvironmentSettings = {
  readonly emulation: SessionEmulation;
  readonly offline: SessionSetting<boolean>;
  readonly headers: SessionSetting<Readonly<Record<string, string>>>;
  readonly media: SessionSetting<{
    readonly colorScheme: "dark" | "light" | "no-preference";
    readonly reducedMotion: "reduce" | "no-preference";
  }>;
};

export type IndexedDbSerializedValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<IndexedDbSerializedValue>
  | { readonly [key: string]: IndexedDbSerializedValue };

export type IndexedDbRecord = {
  readonly key?: IndexedDbSerializedValue;
  readonly keyEncoded?: IndexedDbSerializedValue;
  readonly value?: IndexedDbSerializedValue;
  readonly valueEncoded?: IndexedDbSerializedValue;
};

export type IndexedDbIndex = {
  readonly name: string;
  readonly keyPath?: string;
  readonly keyPathArray?: ReadonlyArray<string>;
  readonly multiEntry: boolean;
  readonly unique: boolean;
};

export type IndexedDbObjectStore = {
  readonly name: string;
  readonly autoIncrement: boolean;
  readonly keyPath?: string;
  readonly keyPathArray?: ReadonlyArray<string>;
  readonly records: ReadonlyArray<IndexedDbRecord>;
  readonly indexes: ReadonlyArray<IndexedDbIndex>;
};

export type IndexedDbDatabase = {
  readonly name: string;
  readonly version: number;
  readonly stores: ReadonlyArray<IndexedDbObjectStore>;
};

export type BrowserStorageState = {
  readonly schemaVersion: 2;
  readonly cookies: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly expires: number;
    readonly httpOnly: boolean;
    readonly secure: boolean;
    readonly sameSite: "Strict" | "Lax" | "None";
  }>;
  readonly origins: ReadonlyArray<{
    readonly origin: string;
    readonly localStorage: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly indexedDB: ReadonlyArray<IndexedDbDatabase>;
  }>;
  readonly tabs: ReadonlyArray<{
    readonly url: string;
    readonly sessionStorage: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }>;
};

export type StateLoadCounts = {
  readonly cookies: number;
  readonly origins: number;
  readonly tabs: number;
  readonly indexedDB: number;
};

export type StateLoadResult =
  | ({
      readonly _tag: "StateLoadResult";
      readonly status: "complete";
      readonly loaded: true;
    } & StateLoadCounts)
  | ({
      readonly _tag: "StateLoadResult";
      readonly status: "incomplete";
      readonly reason: "missing_tab" | "ambiguous_tab" | "missing_origin";
    } & StateLoadCounts)
  | ({
      readonly _tag: "StateLoadResult";
      readonly status: "unsupported";
      readonly reason: "indexeddb" | "session_storage";
    } & StateLoadCounts);

export type BooleanResult = {
  readonly _tag: "BooleanResult";
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly checked?: boolean;
};

export type BatchResultEntry = {
  readonly success: boolean;
  readonly data?: CommandResultData;
  readonly error?: string;
};

export type BatchResult = {
  readonly _tag: "BatchResult";
  readonly results: ReadonlyArray<BatchResultEntry>;
};

export type CommandResultData =
  | NavigateResult
  | VoidResult
  | LocatorResult
  | KeyStateResult
  | SnapshotResult
  | ScreenshotResult
  | EvalResult
  | TabResult
  | CookiesResult
  | WaitResult
  | GetTextResult
  | GetValueResult
  | GetHtmlResult
  | PageUrlResult
  | PageTitleResult
  | CountResult
  | BoundingBoxResult
  | ElementStylesResult
  | StorageResult
  | ConsoleResult
  | PageErrorsResult
  | ClearedResult
  | NetworkRequestsResult
  | NetworkRequestDetailResult
  | BinaryFileResult
  | ClipboardResult
  | DialogResult
  | FrameResult
  | CdpUrlResult
  | TouchResult
  | DeviceListResult
  | StateLoadResult
  | StartedResult
  | BooleanResult
  | BatchResult;

// ─── Profile errors ───

export type ProfileUnavailableReason = "invalid_name" | "not_registered" | "source_unavailable";

export type RefStaleReason = "snapshot" | "frame" | "page" | "navigation";

// ─── ControllerError ───
export type ControllerError =
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string; readonly reason: string }
  | { readonly _tag: "SessionNotReady"; readonly sessionId: string; readonly state: string }
  | { readonly _tag: "ContainerCreateFailed"; readonly message: string }
  | { readonly _tag: "CdpUnreachable"; readonly containerId: string }
  | { readonly _tag: "CdpDisconnected"; readonly containerId: string }
  | { readonly _tag: "ProfileCopyFailed"; readonly message: string }
  | {
      readonly _tag: "ProfileUnavailable";
      readonly profile: string;
      readonly reason: ProfileUnavailableReason;
    }
  | { readonly _tag: "ElementNotFound"; readonly selector?: string }
  | { readonly _tag: "StaleReference"; readonly ref: string; readonly reason: RefStaleReason }
  | { readonly _tag: "Timeout"; readonly operation: string }
  | { readonly _tag: "CommandFailed"; readonly message: string }
  | { readonly _tag: "ValidationFailed"; readonly message: string }
  | {
      readonly _tag: "CapacityExceeded";
      readonly owner: string;
      readonly current: number;
      readonly limit: number;
      readonly ownerCurrent: number;
      readonly ownerLimit: number;
      readonly retryCondition: string;
    };

export type CommandFailureCause =
  | { readonly _tag: "container_creation" }
  | { readonly _tag: "cdp" }
  | { readonly _tag: "cleanup" }
  | { readonly _tag: "transport" };

export type CommandFailureCauseTag = CommandFailureCause["_tag"];

export type WireErrorType = "target_not_found" | "invalid_value" | "command_failed" | "capacity_exceeded" | "timeout";

export type WireFailure =
  | {
      readonly errorType: "target_not_found";
      readonly cause?: never;
    }
  | {
      readonly errorType: "invalid_value";
      readonly cause?: never;
    }
  | {
      readonly errorType: "timeout";
      readonly cause?: never;
    }
  | {
      readonly errorType: "command_failed";
      readonly cause: CommandFailureCauseTag;
    }
  | {
      readonly errorType: "capacity_exceeded";
      readonly cause?: never;
      readonly owner: string;
      readonly current: number;
      readonly limit: number;
      readonly ownerCurrent: number;
      readonly ownerLimit: number;
      readonly retryCondition: string;
    };

// ─── SessionState ───

export type SessionState =
  | { readonly _tag: "Registering" }
  | { readonly _tag: "CreatingContainer"; readonly profilePath: string }
  | { readonly _tag: "ConnectingCDP"; readonly containerId: string }
  | {
      readonly _tag: "Active";
      readonly containerId: string;
      readonly containerIp: string;
      readonly cdpUrl: string;
      readonly createdAt: number;
      readonly lastActivity: number;
    }
  | { readonly _tag: "Expired"; readonly reason: string };

// ─── ErrorCode ───

export const ErrorCode: Record<ControllerError["_tag"], number> = {
  SessionNotFound: 77,
  SessionExpired: 83,
  SessionNotReady: 77,
  ContainerCreateFailed: 80,
  CdpUnreachable: 81,
  CdpDisconnected: 81,
  ProfileCopyFailed: 82,
  ProfileUnavailable: 2,
  ElementNotFound: 66,
  StaleReference: 67,
  Timeout: 75,
  CommandFailed: 1,
  ValidationFailed: 2,
  CapacityExceeded: 84,
};

// ─── BrowserCommand ───

export type NthSubaction =
  | "click"
  | "fill"
  | "type"
  | "hover"
  | "dblclick"
  | "focus"
  | "select"
  | "check"
  | "uncheck";

export type BrowserCommand =
  // 导航
  | { readonly action: "navigate"; readonly url: string; readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" | "none"; readonly headers?: Readonly<Record<string, string>> }
  | { readonly action: "back" }
  | { readonly action: "forward" }
  | { readonly action: "reload" }
  | { readonly action: "wait"; readonly time?: number; readonly selector?: string; readonly text?: string; readonly state?: string; readonly timeout?: number }
  | { readonly action: "waitforurl"; readonly url: string; readonly timeout?: number }
  | { readonly action: "waitforloadstate"; readonly state: string; readonly timeout?: number }
  | { readonly action: "waitforfunction"; readonly expression: string; readonly timeout?: number }

  // 语义定位器
  | {
      readonly action: "getbyrole";
      readonly role: string;
      readonly name?: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "fill" | "type" | "check" | "uncheck" | "hover";
      readonly value?: string;
      readonly nth?: number;
    }
  | {
      readonly action: "getbylabel";
      readonly label: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "fill" | "type" | "check" | "uncheck" | "hover";
      readonly value?: string;
    }
  | {
      readonly action: "getbyplaceholder";
      readonly placeholder: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "fill" | "type";
      readonly value?: string;
    }
  | {
      readonly action: "getbytext";
      readonly text: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "hover";
    }
  | {
      readonly action: "getbyalttext";
      readonly text: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "hover";
    }
  | {
      readonly action: "getbytitle";
      readonly text: string;
      readonly exact?: boolean;
      readonly subaction?: "click" | "hover";
    }
  | {
      readonly action: "getbytestid";
      readonly testId: string;
      readonly subaction?: "click" | "fill" | "type";
      readonly value?: string;
    }

  // @eN 引用 / CSS selector 操作
  | { readonly action: "click"; readonly ref?: string; readonly selector?: string; readonly newTab?: boolean }
  | { readonly action: "fill"; readonly ref?: string; readonly selector?: string; readonly value: string }
  | { readonly action: "type"; readonly ref?: string; readonly selector?: string; readonly text: string }
  | { readonly action: "hover"; readonly ref?: string; readonly selector?: string }

  // 页面信息
  | { readonly action: "snapshot"; readonly selector?: string; readonly ref?: string; readonly interactive?: boolean; readonly compact?: boolean; readonly maxDepth?: number }
  | { readonly action: "screenshot"; readonly format?: "png" | "jpeg"; readonly quality?: number; readonly selector?: string; readonly ref?: string; readonly fullPage?: boolean; readonly annotate?: boolean }
  | { readonly action: "eval"; readonly code: string }

  // 键盘
  | { readonly action: "press"; readonly key: string }

  // 滚动
  | { readonly action: "scroll"; readonly direction: "up" | "down" | "left" | "right"; readonly amount?: number }

  // Tab 管理
  | { readonly action: "tab_new"; readonly url?: string }
  | { readonly action: "tab_switch"; readonly index: number }
  | { readonly action: "tab_close"; readonly index?: number }
  | { readonly action: "tab_list" }

  // Cookie
  | { readonly action: "cookies_get"; readonly url?: string }
  | { readonly action: "cookies_clear" }

  // 元素属性查询 (get)
  | { readonly action: "gettext"; readonly selector: string }
  | { readonly action: "innertext"; readonly selector: string }
  | { readonly action: "innerhtml"; readonly selector: string }
  | { readonly action: "inputvalue"; readonly selector: string }
  | { readonly action: "getattribute"; readonly selector: string; readonly attribute: string }
  | { readonly action: "url" }
  | { readonly action: "title" }
  | { readonly action: "count"; readonly selector: string }
  | { readonly action: "boundingbox"; readonly selector: string }
  | { readonly action: "styles"; readonly selector: string }

  // 元素状态查询 (is)
  | { readonly action: "isvisible"; readonly selector: string }
  | { readonly action: "isenabled"; readonly selector: string }
  | { readonly action: "ischecked"; readonly selector: string }

  // evaluate alias + batch + close
  | { readonly action: "evaluate"; readonly script: string }
  | { readonly action: "batch"; readonly commands: ReadonlyArray<BrowserCommand>; readonly bail?: boolean }
  | { readonly action: "close" }

  // P1 元素操作
  | { readonly action: "dblclick"; readonly selector: string }
  | { readonly action: "check"; readonly selector: string }
  | { readonly action: "uncheck"; readonly selector: string }
  | { readonly action: "select"; readonly selector: string; readonly values: string | ReadonlyArray<string> }
  | { readonly action: "focus"; readonly selector: string }
  | { readonly action: "keyboard"; readonly subaction: "type" | "insertText"; readonly text: string }
  | { readonly action: "keydown"; readonly key: string }
  | { readonly action: "keyup"; readonly key: string }
  | { readonly action: "scrollintoview"; readonly selector: string }
  | { readonly action: "drag"; readonly source: string; readonly target: string }
  | { readonly action: "mousemove"; readonly x: number; readonly y: number }
  | { readonly action: "mousedown"; readonly button: "left" | "right" | "middle" }
  | { readonly action: "mouseup"; readonly button: "left" | "right" | "middle" }
  | { readonly action: "wheel"; readonly deltaX: number; readonly deltaY: number }
  | { readonly action: "viewport"; readonly width: number; readonly height: number; readonly deviceScaleFactor?: number }
  | { readonly action: "device"; readonly device: string }
  | { readonly action: "geolocation"; readonly latitude: number; readonly longitude: number }
  | { readonly action: "offline"; readonly offline: boolean }
  | { readonly action: "headers"; readonly headers: Readonly<Record<string, string>> }
  | { readonly action: "credentials"; readonly username: string; readonly password: string }
  | { readonly action: "emulatemedia"; readonly colorScheme: "dark" | "light" | "no-preference"; readonly reducedMotion: "reduce" | "no-preference" }
  | { readonly action: "storage_get"; readonly type: "local" | "session"; readonly key?: string }
  | { readonly action: "storage_set"; readonly type: "local" | "session"; readonly key: string; readonly value: string }
  | { readonly action: "storage_clear"; readonly type: "local" | "session" }
  | { readonly action: "route"; readonly url: string; readonly abort: boolean; readonly body?: string }
  | { readonly action: "unroute"; readonly url?: string }
  | { readonly action: "requests"; readonly clear: boolean; readonly filter?: string; readonly type?: string; readonly method?: string; readonly status?: string }
  | { readonly action: "request_detail"; readonly requestId: string }
  | { readonly action: "highlight"; readonly selector: string }
  | { readonly action: "window_new" }
  | { readonly action: "nth"; readonly selector: string; readonly index: number; readonly subaction?: NthSubaction; readonly value?: string }
  | { readonly action: "upload"; readonly selector: string; readonly files: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly base64: string;
    }> }
  | { readonly action: "download"; readonly ref?: string; readonly selector?: string }
  | { readonly action: "waitfordownload"; readonly timeout?: number }
  | { readonly action: "pdf" }
  | { readonly action: "clipboard"; readonly operation: "read" | "write" | "copy" | "paste"; readonly text?: string }
  | { readonly action: "tap"; readonly selector: string }
  | { readonly action: "swipe"; readonly direction: "up" | "down" | "left" | "right"; readonly distance?: number }
  | { readonly action: "cdp_url" }
  | { readonly action: "inspect" }
  | { readonly action: "device_list" }
  | { readonly action: "state_save" }
  | { readonly action: "state_load"; readonly state: BrowserStorageState }
  | { readonly action: "trace_start" }
  | { readonly action: "trace_stop" }
  | { readonly action: "profiler_start"; readonly categories?: ReadonlyArray<string> }
  | { readonly action: "profiler_stop" }
  | { readonly action: "har_start" }
  | { readonly action: "har_stop" }
  | { readonly action: "cookies_set"; readonly cookies: ReadonlyArray<{
      readonly name: string;
      readonly value: string;
      readonly url?: string;
      readonly domain?: string;
      readonly path?: string;
      readonly httpOnly?: boolean;
      readonly secure?: boolean;
      readonly sameSite?: "Strict" | "Lax" | "None";
      readonly expires?: number;
    }> }
  | {
      readonly action: "dialog";
      readonly response: "accept" | "dismiss" | "status";
      readonly promptText?: string;
      readonly dialogId?: string;
      readonly pageId?: string;
    }
  | { readonly action: "dialog"; readonly response: "result"; readonly operationId: string }
  | { readonly action: "frame"; readonly selector: string }
  | { readonly action: "mainframe" }
  | { readonly action: "console"; readonly clear?: boolean }
  | { readonly action: "errors"; readonly clear?: boolean };

// ─── WireRequest ───

export type WireRequest =
  | { readonly type: "register"; readonly profile?: string }
  | { readonly type: "deregister"; readonly sessionId: string }
  | { readonly type: "command"; readonly sessionId: string; readonly command: BrowserCommand };

// ─── WireResponse ───

export type WireResponse =
  | {
      readonly type: "register_result";
      readonly success: true;
      readonly sessionId: string;
    }
  | ({
      readonly type: "register_result";
      readonly success: false;
      readonly error: string;
      readonly code: number;
    } & WireFailure)
  | {
      readonly type: "command_result";
      readonly sessionId: string;
      readonly success: true;
      readonly data: CommandResultData;
      readonly boundary?: ContentBoundary;
    }
  | ({
      readonly type: "command_result";
      readonly sessionId: string;
      readonly success: false;
      readonly error: string;
      readonly code: number;
    } & WireFailure)
  | {
      readonly type: "deregister_result";
      readonly sessionId: string;
      readonly success: true;
    }
  | ({
      readonly type: "deregister_result";
      readonly sessionId: string;
      readonly success: false;
      readonly error: string;
      readonly code: number;
    } & WireFailure);

// ─── arktype schemas ───

const indexedDbRecordSchema = type({
  "key?": "unknown",
  "keyEncoded?": "unknown",
  "value?": "unknown",
  "valueEncoded?": "unknown",
});

const indexedDbIndexSchema = type({
  name: "string",
  "keyPath?": "string",
  "keyPathArray?": "string[]",
  multiEntry: "boolean",
  unique: "boolean",
});

const indexedDbStoreSchema = type({
  name: "string",
  autoIncrement: "boolean",
  "keyPath?": "string",
  "keyPathArray?": "string[]",
  records: indexedDbRecordSchema.array(),
  indexes: indexedDbIndexSchema.array(),
});

const indexedDbDatabaseSchema = type({
  name: "string",
  version: "number",
  stores: indexedDbStoreSchema.array(),
});

const stateOriginSchema = type({
  origin: "string",
  localStorage: type({ name: "string", value: "string" }).array(),
  indexedDB: indexedDbDatabaseSchema.array(),
});

const stateTabSchema = type({
  url: "string",
  sessionStorage: type({ name: "string", value: "string" }).array(),
});

const browserStorageStateSchema = type({
  schemaVersion: "2",
  cookies: type({
    name: "string",
    value: "string",
    domain: "string",
    path: "string",
    expires: "number",
    httpOnly: "boolean",
    secure: "boolean",
    sameSite: "'Strict' | 'Lax' | 'None'",
  }).array(),
  origins: stateOriginSchema.array(),
  tabs: stateTabSchema.array(),
});
const dialogOperationSchema = type({ _tag: "'NoOperation'" })
  .or({ _tag: "'PendingOperation'", operationId: "string" })
  .or({
    _tag: "'SettledOperation'",
    operationId: "string",
    result: { _tag: "'EvalResult'", result: "string" },
  })
  .or({ _tag: "'FailedOperation'", operationId: "string", error: "string" })
  .or({ _tag: "'TimedOutOperation'", operationId: "string", operation: "string" });

const dialogPageSchema = type({
  pageId: "string",
  pageIndex: "number",
  pageUrl: "string",
});

export const dialogResultSchema = type({
  _tag: "'DialogResult'",
  state: "'idle'",
  hasDialog: "false",
})
  .or({
    _tag: "'DialogResult'",
    state: "'open' | 'pending'",
    hasDialog: "true",
    dialogId: "string",
    page: dialogPageSchema,
    type: "'alert' | 'beforeunload' | 'confirm' | 'prompt' | 'unknown'",
    message: "string",
    defaultPrompt: "string",
    operation: dialogOperationSchema,
  })
  .or({
    _tag: "'DialogResult'",
    state: "'handled'",
    hasDialog: "false",
    handled: "true",
    accepted: "boolean",
    dialogId: "string",
    page: dialogPageSchema,
    operation: dialogOperationSchema,
  })
  .or({
    _tag: "'DialogResult'",
    state: "'operation'",
    hasDialog: "false",
    operationId: "string",
    operation: dialogOperationSchema,
  });

const browserCommandSchema = type({
  action: "'navigate'",
  url: "string",
  "waitUntil?": "'load' | 'domcontentloaded' | 'networkidle' | 'commit' | 'none'",
  "headers?": type("Record<string, string>"),
})
  .or({ action: "'back'" })
  .or({ action: "'forward'" })
  .or({ action: "'reload'" })
  .or({ action: "'wait'", "time?": "number", "selector?": "string", "text?": "string", "state?": "string", "timeout?": "number" })
  .or({ action: "'waitforurl'", url: "string", "timeout?": "number" })
  .or({ action: "'waitforloadstate'", state: "string", "timeout?": "number" })
  .or({ action: "'waitforfunction'", expression: "string", "timeout?": "number" })
  .or({
    action: "'getbyrole'",
    role: "string",
    "name?": "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'fill' | 'type' | 'check' | 'uncheck' | 'hover'",
    "value?": "string",
    "nth?": "number",
  })
  .or({ action: "'trace_start'" })
  .or({ action: "'trace_stop'" })
  .or({ action: "'profiler_start'", "categories?": "string[]" })
  .or({ action: "'profiler_stop'" })
  .or({ action: "'har_start'" })
  .or({ action: "'har_stop'" })
  .or({
    action: "'getbylabel'",
    label: "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'fill' | 'type' | 'check' | 'uncheck' | 'hover'",
    "value?": "string",
  })
  .or({
    action: "'getbyplaceholder'",
    placeholder: "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'fill' | 'type'",
    "value?": "string",
  })
  .or({
    action: "'getbytext'",
    text: "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'hover'",
  })
  .or({
    action: "'getbyalttext'",
    text: "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'hover'",
  })
  .or({
    action: "'getbytitle'",
    text: "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'hover'",
  })
  .or({
    action: "'getbytestid'",
    testId: "string",
    "subaction?": "'click' | 'fill' | 'type'",
    "value?": "string",
  })
  .or({ action: "'click'", "ref?": "string", "selector?": "string", "newTab?": "boolean" })
  .or({ action: "'fill'", "ref?": "string", "selector?": "string", value: "string" })
  .or({ action: "'type'", "ref?": "string", "selector?": "string", text: "string" })
  .or({ action: "'hover'", "ref?": "string", "selector?": "string" })
  .or({ action: "'snapshot'", "selector?": "string", "ref?": "string", "interactive?": "boolean", "compact?": "boolean", "maxDepth?": "number.integer >= 0" })
  .or({
    action: "'screenshot'",
    "format?": "'png' | 'jpeg'",
    "quality?": "number",
    "selector?": "string",
    "ref?": "string",
    "fullPage?": "boolean",
    "annotate?": "boolean",
  })
  .or({ action: "'eval'", code: "string" })
  .or({ action: "'press'", key: "string" })
  .or({
    action: "'scroll'",
    direction: "'up' | 'down' | 'left' | 'right'",
    "amount?": "number",
  })
  .or({ action: "'tab_new'", "url?": "string" })
  .or({ action: "'tab_switch'", index: "number" })
  .or({ action: "'tab_close'", "index?": "number" })
  .or({ action: "'tab_list'" })
  .or({ action: "'cookies_get'", "url?": "string" })
  .or({ action: "'cookies_clear'" })
  .or({ action: "'gettext'", selector: "string" })
  .or({ action: "'innertext'", selector: "string" })
  .or({ action: "'innerhtml'", selector: "string" })
  .or({ action: "'inputvalue'", selector: "string" })
  .or({ action: "'getattribute'", selector: "string", attribute: "string" })
  .or({ action: "'url'" })
  .or({ action: "'title'" })
  .or({ action: "'count'", selector: "string" })
  .or({ action: "'boundingbox'", selector: "string" })
  .or({ action: "'styles'", selector: "string" })
  .or({ action: "'isvisible'", selector: "string" })
  .or({ action: "'isenabled'", selector: "string" })
  .or({ action: "'ischecked'", selector: "string" })
  .or({ action: "'evaluate'", script: "string" })
  .or({ action: "'batch'", commands: type("object").array(), "bail?": "boolean" })
  .or({ action: "'close'" })
  .or({ action: "'dblclick'", selector: "string" })
  .or({ action: "'check'", selector: "string" })
  .or({ action: "'uncheck'", selector: "string" })
  .or({ action: "'select'", selector: "string", values: "string | string[]" })
  .or({ action: "'focus'", selector: "string" })
  .or({ action: "'keyboard'", subaction: "'type' | 'insertText'", text: "string" })
  .or({ action: "'keydown'", key: "string" })
  .or({ action: "'keyup'", key: "string" })
  .or({ action: "'scrollintoview'", selector: "string" })
  .or({ action: "'drag'", source: "string", target: "string" })
  .or({ action: "'mousemove'", x: "number", y: "number" })
  .or({ action: "'mousedown'", button: "'left' | 'right' | 'middle'" })
  .or({ action: "'mouseup'", button: "'left' | 'right' | 'middle'" })
  .or({ action: "'wheel'", deltaX: "number", deltaY: "number" })
  .or({ action: "'viewport'", width: "number", height: "number", "deviceScaleFactor?": "number" })
  .or({ action: "'device'", device: "string" })
  .or({ action: "'geolocation'", latitude: "number", longitude: "number" })
  .or({ action: "'offline'", offline: "boolean" })
  .or({ action: "'headers'", headers: type("Record<string, string>") })
  .or({ action: "'credentials'", username: "string", password: "string" })
  .or({ action: "'emulatemedia'", colorScheme: "'dark' | 'light' | 'no-preference'", reducedMotion: "'reduce' | 'no-preference'" })
  .or({ action: "'storage_get'", type: "'local' | 'session'", "key?": "string" })
  .or({ action: "'storage_set'", type: "'local' | 'session'", key: "string", value: "string" })
  .or({ action: "'storage_clear'", type: "'local' | 'session'" })
  .or({ action: "'route'", url: "string", abort: "boolean", "body?": "string" })
  .or({ action: "'unroute'", "url?": "string" })
  .or({ action: "'requests'", clear: "boolean", "filter?": "string", "type?": "string", "method?": "string", "status?": "string" })
  .or({ action: "'request_detail'", requestId: "string" })
  .or({ action: "'highlight'", selector: "string" })
  .or({ action: "'window_new'" })
  .or({ action: "'nth'", selector: "string", index: "number", "subaction?": "'click' | 'fill' | 'type' | 'hover' | 'dblclick' | 'focus' | 'select' | 'check' | 'uncheck'", "value?": "string" })
  .or({ action: "'upload'", selector: "string", files: type({ name: "string", mimeType: "string", base64: "string" }).array() })
  .or({ action: "'download'", "ref?": "string", "selector?": "string" })
  .or({ action: "'waitfordownload'", "timeout?": "number" })
  .or({ action: "'pdf'" })
  .or({ action: "'clipboard'", operation: "'read' | 'write' | 'copy' | 'paste'", "text?": "string" })
  .or({ action: "'tap'", selector: "string" })
  .or({ action: "'swipe'", direction: "'up' | 'down' | 'left' | 'right'", "distance?": "number" })
  .or({ action: "'cdp_url'" })
  .or({ action: "'inspect'" })
  .or({ action: "'device_list'" })
  .or({ action: "'state_save'" })
  .or({
    action: "'state_load'",
    state: browserStorageStateSchema,
  })
  .or({ action: "'cookies_set'", cookies: type({
    name: "string",
    value: "string",
    "url?": "string",
    "domain?": "string",
    "path?": "string",
    "httpOnly?": "boolean",
    "secure?": "boolean",
    "sameSite?": "'Strict' | 'Lax' | 'None'",
    "expires?": "number",
  }).array() })
  .or({
    action: "'dialog'",
    response: "'accept' | 'dismiss' | 'status'",
    "promptText?": "string",
    "dialogId?": "string",
    "pageId?": "string",
  })
  .or({ action: "'dialog'", response: "'result'", operationId: "string" })
  .or({ action: "'frame'", selector: "string" })
  .or({ action: "'mainframe'" })
  .or({ action: "'console'", "clear?": "boolean" })
  .or({ action: "'errors'", "clear?": "boolean" });

export const wireRequestSchema = type({
  type: "'register'",
  "profile?": "string",
})
  .or({
    type: "'deregister'",
    sessionId: "string",
  })
  .or({
    type: "'command'",
    sessionId: "string",
    command: browserCommandSchema,
  });
