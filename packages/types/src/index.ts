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

export type SnapshotResult = {
  readonly _tag: "SnapshotResult";
  readonly snapshot: string;
};

export type ScreenshotResult = {
  readonly _tag: "ScreenshotResult";
  readonly base64: string;
  readonly format: "png" | "jpeg";
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

export type CommandResultData =
  | NavigateResult
  | VoidResult
  | LocatorResult
  | SnapshotResult
  | ScreenshotResult
  | EvalResult
  | TabResult
  | CookiesResult;

// ─── ControllerError ───

export type ControllerError =
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string; readonly reason: string }
  | { readonly _tag: "SessionNotReady"; readonly sessionId: string; readonly state: string }
  | { readonly _tag: "ContainerCreateFailed"; readonly message: string }
  | { readonly _tag: "CdpUnreachable"; readonly containerId: string }
  | { readonly _tag: "CdpDisconnected"; readonly containerId: string }
  | { readonly _tag: "ProfileCopyFailed"; readonly message: string }
  | { readonly _tag: "ElementNotFound"; readonly selector?: string }
  | { readonly _tag: "Timeout"; readonly operation: string }
  | { readonly _tag: "CommandFailed"; readonly message: string }
  | { readonly _tag: "ValidationFailed"; readonly message: string };

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
  | { readonly _tag: "Reconnecting"; readonly since: number; readonly containerId: string }
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
  ElementNotFound: 66,
  Timeout: 75,
  CommandFailed: 1,
  ValidationFailed: 2,
};

// ─── BrowserCommand ───

export type BrowserCommand =
  // 导航
  | { readonly action: "navigate"; readonly url: string }
  | { readonly action: "back" }
  | { readonly action: "forward" }
  | { readonly action: "reload" }
  | { readonly action: "wait"; readonly time?: number }

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

  // @eN 引用操作
  | { readonly action: "click"; readonly ref: string }
  | { readonly action: "fill"; readonly ref: string; readonly value: string }
  | { readonly action: "type"; readonly ref: string; readonly value: string }
  | { readonly action: "hover"; readonly ref: string }

  // 页面信息
  | { readonly action: "snapshot" }
  | { readonly action: "screenshot"; readonly format?: "png" | "jpeg"; readonly quality?: number }
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
  | { readonly action: "cookies_clear" };

// ─── WireRequest ───

export type WireRequest =
  | { readonly type: "register"; readonly profile?: string }
  | { readonly type: "resume"; readonly sessionId: string }
  | { readonly type: "deregister"; readonly sessionId: string }
  | { readonly type: "command"; readonly sessionId: string; readonly command: BrowserCommand };

// ─── WireResponse ───

export type WireResponse =
  | {
      readonly type: "register_result";
      readonly success: true;
      readonly sessionId: string;
    }
  | {
      readonly type: "register_result";
      readonly success: false;
      readonly error: string;
      readonly code: number;
    }
  | {
      readonly type: "command_result";
      readonly sessionId: string;
      readonly success: true;
      readonly data: CommandResultData;
      readonly boundary?: ContentBoundary;
    }
  | {
      readonly type: "command_result";
      readonly sessionId: string;
      readonly success: false;
      readonly error: string;
      readonly code: number;
    }
  | {
      readonly type: "deregister_result";
      readonly sessionId: string;
      readonly success: boolean;
    };

// ─── arktype schemas ───

const browserCommandSchema = type({
  action: "'navigate'",
  url: "string",
})
  .or({ action: "'back'" })
  .or({ action: "'forward'" })
  .or({ action: "'reload'" })
  .or({ action: "'wait'", "time?": "number" })
  .or({
    action: "'getbyrole'",
    role: "string",
    "name?": "string",
    "exact?": "boolean",
    "subaction?": "'click' | 'fill' | 'type' | 'check' | 'uncheck' | 'hover'",
    "value?": "string",
    "nth?": "number",
  })
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
  .or({ action: "'click'", ref: "string" })
  .or({ action: "'fill'", ref: "string", value: "string" })
  .or({ action: "'type'", ref: "string", value: "string" })
  .or({ action: "'hover'", ref: "string" })
  .or({ action: "'snapshot'" })
  .or({
    action: "'screenshot'",
    "format?": "'png' | 'jpeg'",
    "quality?": "number",
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
  .or({ action: "'cookies_clear'" });

export const wireRequestSchema = type({
  type: "'register'",
  "profile?": "string",
})
  .or({
    type: "'resume'",
    sessionId: "string",
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
