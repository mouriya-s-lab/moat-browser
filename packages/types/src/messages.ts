import type { ProfileInfo } from "./container.js";

// ---- Cookie info ----
export type CookieInfo = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expires?: number;
};

// ---- Browser Command ADT ----
export type BrowserCommand =
  | { readonly _tag: "Navigate"; readonly url: string }
  | { readonly _tag: "Click"; readonly ref: string }
  | { readonly _tag: "Fill"; readonly ref: string; readonly value: string }
  | { readonly _tag: "Snapshot" }
  | { readonly _tag: "Screenshot" }
  | { readonly _tag: "Wait"; readonly ms: number }
  | { readonly _tag: "Evaluate"; readonly expression: string }
  | { readonly _tag: "GetCookies" }
  | { readonly _tag: "NewTab"; readonly url?: string }
  | { readonly _tag: "SwitchTab"; readonly tabName: string }
  | { readonly _tag: "CloseTab"; readonly tabName: string };

// ---- Browser Result ADT ----
export type BrowserResult =
  | { readonly _tag: "NavigateResult"; readonly url: string; readonly title: string }
  | { readonly _tag: "ClickResult"; readonly success: boolean }
  | { readonly _tag: "FillResult"; readonly success: boolean }
  | { readonly _tag: "SnapshotResult"; readonly snapshot: string }
  | { readonly _tag: "ScreenshotResult"; readonly base64Png: string }
  | { readonly _tag: "WaitResult" }
  | { readonly _tag: "EvaluateResult"; readonly value: unknown }
  | { readonly _tag: "CookiesResult"; readonly cookies: readonly CookieInfo[] }
  | { readonly _tag: "TabResult"; readonly tabName: string }
  | { readonly _tag: "CommandError"; readonly message: string };

// ---- Client → Server Event ADT ----
export type ClientEvent =
  | { readonly _tag: "Register"; readonly agentId: string; readonly profile: string; readonly token: string; readonly instance?: string }
  | { readonly _tag: "Deregister"; readonly sessionId: string }
  | { readonly _tag: "Command"; readonly sessionId: string; readonly command: BrowserCommand }
  | { readonly _tag: "StartUserChrome"; readonly profileName: string }
  | { readonly _tag: "StopUserChrome" }
  | { readonly _tag: "FreezeProfile"; readonly profileName: string }
  | { readonly _tag: "ListProfiles" }
  | { readonly _tag: "Ping" };

// ---- Server → Client Event ADT ----
export type ServerEvent =
  | { readonly _tag: "Registered"; readonly sessionId: string; readonly expiresAt: string }
  | { readonly _tag: "Deregistered"; readonly sessionId: string }
  | { readonly _tag: "CommandResult"; readonly sessionId: string; readonly result: BrowserResult }
  | { readonly _tag: "UserChromeStarted"; readonly nekoUrl: string }
  | { readonly _tag: "UserChromeStopped" }
  | { readonly _tag: "ProfileFrozen"; readonly profileName: string; readonly frozenAt: string }
  | { readonly _tag: "ProfileList"; readonly profiles: readonly ProfileInfo[] }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string; readonly reason: string }
  | { readonly _tag: "Error"; readonly error: GatewayError }
  | { readonly _tag: "Pong" };

// ---- Gateway Error ADT ----
export type GatewayError =
  | { readonly _tag: "AuthenticationFailed"; readonly reason: string }
  | { readonly _tag: "TokenExpired" }
  | { readonly _tag: "AgentAlreadyRegistered"; readonly agentId: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "ProfileNotFound"; readonly profileName: string }
  | { readonly _tag: "DomainBlocked"; readonly url: string; readonly domain: string }
  | { readonly _tag: "BudgetExceeded"; readonly limit: string; readonly current: number; readonly max: number }
  | { readonly _tag: "ContainerError"; readonly message: string }
  | { readonly _tag: "InternalError"; readonly message: string };
