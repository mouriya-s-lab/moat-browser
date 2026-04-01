// BrowserCommand — commands sent from shim to controller
export type BrowserCommand =
  | { readonly _tag: "Navigate"; readonly url: string }
  | { readonly _tag: "Click"; readonly ref: string }
  | { readonly _tag: "Fill"; readonly ref: string; readonly value: string }
  | { readonly _tag: "Snapshot" }
  | { readonly _tag: "Screenshot" }
  | { readonly _tag: "Evaluate"; readonly expression: string }
  | { readonly _tag: "NewTab"; readonly url?: string }
  | { readonly _tag: "SwitchTab"; readonly tabName: string }
  | { readonly _tag: "CloseTab"; readonly tabName: string }
  | { readonly _tag: "Wait"; readonly ms: number };

// BrowserResult — responses from controller to shim
export type BrowserResult =
  | { readonly _tag: "NavigateResult"; readonly url: string; readonly title: string }
  | { readonly _tag: "ClickResult"; readonly success: boolean }
  | { readonly _tag: "FillResult"; readonly success: boolean }
  | { readonly _tag: "SnapshotResult"; readonly snapshot: string }
  | { readonly _tag: "ScreenshotResult"; readonly base64Png: string }
  | { readonly _tag: "EvaluateResult"; readonly value: unknown }
  | { readonly _tag: "TabResult"; readonly tabName: string }
  | { readonly _tag: "WaitResult" }
  | { readonly _tag: "CommandError"; readonly message: string };

// GatewayError — protocol-level errors
export type GatewayError =
  | { readonly _tag: "AuthenticationFailed"; readonly reason: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionNotReady"; readonly state: string }
  | { readonly _tag: "ContainerError"; readonly message: string }
  | { readonly _tag: "CDPError"; readonly message: string }
  | { readonly _tag: "InternalError"; readonly message: string };
