// BrowserCommand ADT
export type Navigate = { readonly _tag: "Navigate"; readonly url: string };
export type Click = { readonly _tag: "Click"; readonly selector: string };
export type Fill = { readonly _tag: "Fill"; readonly selector: string; readonly value: string };
export type Snapshot = { readonly _tag: "Snapshot" };
export type Screenshot = { readonly _tag: "Screenshot" };
export type Evaluate = { readonly _tag: "Evaluate"; readonly expression: string };
export type NewTab = { readonly _tag: "NewTab"; readonly url?: string };
export type SwitchTab = { readonly _tag: "SwitchTab"; readonly index: number };
export type CloseTab = { readonly _tag: "CloseTab"; readonly index: number };
export type Wait = { readonly _tag: "Wait"; readonly selector: string; readonly timeout?: number };

export type BrowserCommand =
  | Navigate
  | Click
  | Fill
  | Snapshot
  | Screenshot
  | Evaluate
  | NewTab
  | SwitchTab
  | CloseTab
  | Wait;

// BrowserResult ADT
export type TabInfo = { readonly index: number; readonly url: string; readonly title: string };

export type NavigateResult = { readonly _tag: "NavigateResult"; readonly url: string; readonly title: string };
export type ClickResult = { readonly _tag: "ClickResult" };
export type FillResult = { readonly _tag: "FillResult" };
export type SnapshotResult = { readonly _tag: "SnapshotResult"; readonly aria: string };
export type ScreenshotResult = { readonly _tag: "ScreenshotResult"; readonly png: string };
export type EvaluateResult = { readonly _tag: "EvaluateResult"; readonly value: unknown };
export type TabResult = { readonly _tag: "TabResult"; readonly tabs: ReadonlyArray<TabInfo> };
export type WaitResult = { readonly _tag: "WaitResult" };

export type BrowserResult =
  | NavigateResult
  | ClickResult
  | FillResult
  | SnapshotResult
  | ScreenshotResult
  | EvaluateResult
  | TabResult
  | WaitResult;

// GatewayError ADT
export type AuthError = { readonly _tag: "AuthError"; readonly message: string };
export type SessionNotFound = { readonly _tag: "SessionNotFound"; readonly sessionId: string };
export type SessionExpired = { readonly _tag: "SessionExpired"; readonly sessionId: string };
export type CommandError = { readonly _tag: "CommandError"; readonly command: string; readonly message: string };
export type ContainerError = { readonly _tag: "ContainerError"; readonly message: string };
export type ValidationError = { readonly _tag: "ValidationError"; readonly message: string };

export type GatewayError =
  | AuthError
  | SessionNotFound
  | SessionExpired
  | CommandError
  | ContainerError
  | ValidationError;
