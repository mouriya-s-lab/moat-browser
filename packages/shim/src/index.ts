// @moat-browser/shim — public API
export {
  MoatBrowserClient,
  type ClientOptions,
  type RegisterResult,
  type DeregisterResult,
  type NavigateResult,
  type ClickResult,
  type FillResult,
  type SnapshotResult,
  type ScreenshotResult,
  type EvaluateResult,
  type TabResult,
  type CommandError,
} from "./client.js";

// Re-export core types for consumers who don't want to import @moat-browser/types directly
export type {
  BrowserCommand,
  BrowserResult,
  GatewayError,
} from "@moat-browser/types";
