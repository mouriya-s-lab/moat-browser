// Protocol Bridge — agent-browser-session JSON-line ↔ BrowserCommand ADT (design.md §6.2)
// exhaustive switch guarantees no command variant is dropped
import type { BrowserCommand, BrowserResult } from "@moat-browser/types";
import { exhaustive } from "@moat-browser/types";

export interface ProtocolError {
  readonly _tag: "ProtocolError";
  readonly message: string;
}

// agent-browser-session raw command (JSON-line request)
export interface RawCommand {
  readonly id?: string;
  readonly action: string;
  readonly [key: string]: unknown;
}

// agent-browser-session raw response (JSON-line response)
export interface RawResponse {
  readonly id?: string;
  readonly success: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

// Direction 1: agent-browser-session command → BrowserCommand ADT
export function toBrowserCommand(
  raw: unknown
): BrowserCommand | ProtocolError {
  if (typeof raw !== "object" || raw === null || !("action" in raw)) {
    return { _tag: "ProtocolError", message: "Missing 'action' field" };
  }

  const cmd = raw as RawCommand;

  switch (cmd.action) {
    case "navigate": {
      if (typeof cmd["url"] !== "string") {
        return { _tag: "ProtocolError", message: "navigate requires 'url: string'" };
      }
      return { _tag: "Navigate", url: cmd["url"] };
    }

    case "click": {
      if (typeof cmd["ref"] !== "string") {
        return { _tag: "ProtocolError", message: "click requires 'ref: string'" };
      }
      return { _tag: "Click", ref: cmd["ref"] };
    }

    case "fill": {
      if (typeof cmd["ref"] !== "string" || typeof cmd["value"] !== "string") {
        return { _tag: "ProtocolError", message: "fill requires 'ref: string' and 'value: string'" };
      }
      return { _tag: "Fill", ref: cmd["ref"], value: cmd["value"] };
    }

    case "snapshot":
      return { _tag: "Snapshot" };

    case "screenshot":
      return { _tag: "Screenshot" };

    case "evaluate": {
      if (typeof cmd["expression"] !== "string") {
        return { _tag: "ProtocolError", message: "evaluate requires 'expression: string'" };
      }
      return { _tag: "Evaluate", expression: cmd["expression"] };
    }

    case "new_tab":
    case "newTab": {
      const url = typeof cmd["url"] === "string" ? cmd["url"] : undefined;
      return { _tag: "NewTab", url };
    }

    case "switch_tab":
    case "switchTab": {
      if (typeof cmd["tabName"] !== "string") {
        return { _tag: "ProtocolError", message: "switchTab requires 'tabName: string'" };
      }
      return { _tag: "SwitchTab", tabName: cmd["tabName"] };
    }

    case "close_tab":
    case "closeTab": {
      if (typeof cmd["tabName"] !== "string") {
        return { _tag: "ProtocolError", message: "closeTab requires 'tabName: string'" };
      }
      return { _tag: "CloseTab", tabName: cmd["tabName"] };
    }

    case "wait": {
      if (typeof cmd["ms"] !== "number") {
        return { _tag: "ProtocolError", message: "wait requires 'ms: number'" };
      }
      return { _tag: "Wait", ms: cmd["ms"] };
    }

    default:
      return { _tag: "ProtocolError", message: `Unknown action: ${String(cmd.action)}` };
  }
}

// Direction 2: BrowserResult ADT → agent-browser-session response
// exhaustive switch — every BrowserResult variant is handled
export function fromBrowserResult(result: BrowserResult): Record<string, unknown> {
  switch (result._tag) {
    case "NavigateResult":
      return { url: result.url, title: result.title };

    case "ClickResult":
      return { success: result.success };

    case "FillResult":
      return { success: result.success };

    case "SnapshotResult":
      return { snapshot: result.snapshot };

    case "ScreenshotResult":
      return { base64Png: result.base64Png };

    case "EvaluateResult":
      return { value: result.value };

    case "TabResult":
      return { tabName: result.tabName };

    case "WaitResult":
      return {};

    case "CommandError":
      return { error: result.message };

    default:
      return exhaustive(result);
  }
}

// Build a RawResponse from a BrowserResult (includes id from original request)
export function buildResponse(
  id: string | undefined,
  result: BrowserResult
): RawResponse {
  const data = fromBrowserResult(result);
  const isError = result._tag === "CommandError";
  return {
    id,
    success: !isError,
    ...(isError
      ? { error: (data as { error: string }).error }
      : { result: data }),
  };
}
