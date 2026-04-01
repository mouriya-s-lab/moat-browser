/**
 * protocol-bridge.ts — agent-browser-session JSON-line ↔ BrowserCommand ADT
 *
 * The agent-browser-session protocol uses JSON-line messages:
 *   Input:  { id: string, command: string, ...params }
 *   Output: { id: string, ok: true, result: BrowserResult }
 *        or { id: string, ok: false, error: GatewayError }
 *
 * This bridge converts between that format and the typed BrowserCommand ADT.
 * All command tags must be handled — enforced via exhaustive().
 */

import { exhaustive } from "@moat-browser/types";
import type { BrowserCommand, BrowserResult, GatewayError } from "@moat-browser/types";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface WireRequest {
  readonly id: string;
  readonly command: string;
  readonly [key: string]: unknown;
}

export interface WireResponseOk {
  readonly id: string;
  readonly ok: true;
  readonly result: BrowserResult;
}

export interface WireResponseError {
  readonly id: string;
  readonly ok: false;
  readonly error: GatewayError;
}

export type WireResponse = WireResponseOk | WireResponseError;

// ---------------------------------------------------------------------------
// wireToCommand — parse wire request into typed BrowserCommand
// ---------------------------------------------------------------------------

export function wireToCommand(req: WireRequest): BrowserCommand | GatewayError {
  const { command } = req;

  switch (command) {
    case "Navigate": {
      const url = req["url"];
      if (typeof url !== "string") {
        return { _tag: "ValidationError", message: "Navigate requires url: string" };
      }
      return { _tag: "Navigate", url };
    }

    case "Click": {
      const ref = req["ref"];
      if (typeof ref !== "string") {
        return { _tag: "ValidationError", message: "Click requires ref: string" };
      }
      return { _tag: "Click", ref };
    }

    case "Fill": {
      const ref = req["ref"];
      const value = req["value"];
      if (typeof ref !== "string") {
        return { _tag: "ValidationError", message: "Fill requires ref: string" };
      }
      if (typeof value !== "string") {
        return { _tag: "ValidationError", message: "Fill requires value: string" };
      }
      return { _tag: "Fill", ref, value };
    }

    case "Snapshot":
      return { _tag: "Snapshot" };

    case "Screenshot":
      return { _tag: "Screenshot" };

    case "Evaluate": {
      const expression = req["expression"];
      if (typeof expression !== "string") {
        return { _tag: "ValidationError", message: "Evaluate requires expression: string" };
      }
      return { _tag: "Evaluate", expression };
    }

    case "NewTab": {
      const url = req["url"];
      if (url !== undefined && typeof url !== "string") {
        return { _tag: "ValidationError", message: "NewTab url must be a string if provided" };
      }
      return url !== undefined ? { _tag: "NewTab", url } : { _tag: "NewTab" };
    }

    case "SwitchTab": {
      const tabId = req["tabId"];
      if (typeof tabId !== "string") {
        return { _tag: "ValidationError", message: "SwitchTab requires tabId: string" };
      }
      return { _tag: "SwitchTab", tabId };
    }

    case "CloseTab": {
      const tabId = req["tabId"];
      if (typeof tabId !== "string") {
        return { _tag: "ValidationError", message: "CloseTab requires tabId: string" };
      }
      return { _tag: "CloseTab", tabId };
    }

    case "Wait": {
      const ms = req["ms"];
      if (typeof ms !== "number") {
        return { _tag: "ValidationError", message: "Wait requires ms: number" };
      }
      return { _tag: "Wait", ms };
    }

    default:
      return { _tag: "ValidationError", message: `Unknown command: ${command}` };
  }
}

// ---------------------------------------------------------------------------
// resultToWire — convert BrowserResult to wire response
// ---------------------------------------------------------------------------

export function resultToWire(id: string, result: BrowserResult): WireResponseOk {
  // Exhaustive check: ensure all BrowserResult variants are handled
  const tag = result._tag;
  switch (tag) {
    case "NavigateResult":
    case "ClickResult":
    case "FillResult":
    case "SnapshotResult":
    case "ScreenshotResult":
    case "EvaluateResult":
    case "NewTabResult":
    case "SwitchTabResult":
    case "CloseTabResult":
    case "WaitResult":
      return { id, ok: true, result };
    default:
      return exhaustive(tag);
  }
}

// ---------------------------------------------------------------------------
// errorToWire — convert GatewayError to wire error response
// ---------------------------------------------------------------------------

export function errorToWire(id: string, error: GatewayError): WireResponseError {
  return { id, ok: false, error };
}

// ---------------------------------------------------------------------------
// parseWireLine — parse a JSON-line string into WireRequest
// ---------------------------------------------------------------------------

export function parseWireLine(line: string): WireRequest | GatewayError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { _tag: "ValidationError", message: `Invalid JSON: ${line}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { _tag: "ValidationError", message: "Request must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["id"] !== "string") {
    return { _tag: "ValidationError", message: "Request requires id: string" };
  }
  if (typeof obj["command"] !== "string") {
    return { _tag: "ValidationError", message: "Request requires command: string" };
  }

  return obj as WireRequest;
}

// ---------------------------------------------------------------------------
// serializeWireResponse — serialize a WireResponse to JSON-line
// ---------------------------------------------------------------------------

export function serializeWireResponse(resp: WireResponse): string {
  return JSON.stringify(resp) + "\n";
}
