export type BrowserCommand =
  | { readonly _tag: "Navigate"; readonly url: string }
  | { readonly _tag: "Click"; readonly selector: string }
  | { readonly _tag: "Fill"; readonly selector: string; readonly value: string }
  | { readonly _tag: "Snapshot" }
  | { readonly _tag: "Screenshot" }
  | { readonly _tag: "Evaluate"; readonly expression: string }
  | { readonly _tag: "NewTab"; readonly url?: string }
  | { readonly _tag: "SwitchTab"; readonly index: number }
  | { readonly _tag: "CloseTab"; readonly index: number }
  | { readonly _tag: "Wait"; readonly selector: string; readonly timeout?: number };

export type TabInfo = {
  readonly index: number;
  readonly url: string;
  readonly title: string;
};

export type BrowserResult =
  | { readonly _tag: "NavigateResult"; readonly url: string; readonly title: string }
  | { readonly _tag: "ClickResult" }
  | { readonly _tag: "FillResult" }
  | { readonly _tag: "SnapshotResult"; readonly aria: string }
  | { readonly _tag: "ScreenshotResult"; readonly png: string }
  | { readonly _tag: "EvaluateResult"; readonly value: unknown }
  | { readonly _tag: "TabResult"; readonly tabs: ReadonlyArray<TabInfo> }
  | { readonly _tag: "WaitResult" };

export type GatewayError =
  | { readonly _tag: "AuthError"; readonly message: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string }
  | { readonly _tag: "CommandError"; readonly command: string; readonly message: string }
  | { readonly _tag: "ContainerError"; readonly message: string }
  | { readonly _tag: "ValidationError"; readonly message: string };
