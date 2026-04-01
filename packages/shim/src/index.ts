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

export { runDaemon, type DaemonOptions } from "./daemon.js";
export { loadConfig, type ShimConfig } from "./config.js";

export {
  toBrowserCommand,
  fromBrowserResult,
  buildResponse,
  type ProtocolError,
  type RawCommand,
  type RawResponse,
} from "./protocol-bridge.js";

// Re-export core types for consumers who don't want to import @moat-browser/types directly
export type {
  BrowserCommand,
  BrowserResult,
  GatewayError,
} from "@moat-browser/types";
