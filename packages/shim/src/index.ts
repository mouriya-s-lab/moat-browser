/**
 * index.ts — Public exports for @moat-browser/shim
 */

export { MoatBrowserClient } from "./client.js";
export type {
  ClientEvent,
  RegisterResult,
  NavigateResult,
  ClickResult,
  FillResult,
  SnapshotResult,
  ScreenshotResult,
  EvaluateResult,
  TabResult,
  CommandError,
} from "./client.js";

export { ShimDaemon } from "./daemon.js";
export type { DaemonOptions } from "./daemon.js";

export {
  wireToCommand,
  resultToWire,
  errorToWire,
  parseWireLine,
  serializeWireResponse,
} from "./protocol-bridge.js";
export type {
  WireRequest,
  WireResponse,
  WireResponseOk,
  WireResponseError,
} from "./protocol-bridge.js";

export { config } from "./config.js";
