/**
 * protocol-bridge.test.ts — Unit tests for protocol bridge
 *
 * Tests:
 * - wireToCommand: all 10 commands, invalid inputs
 * - resultToWire: all BrowserResult variants (exhaustive)
 * - parseWireLine: valid JSON, invalid JSON, missing fields
 * - serializeWireResponse: round-trip
 */

import { describe, test, expect } from "bun:test";
import {
  wireToCommand,
  resultToWire,
  errorToWire,
  parseWireLine,
  serializeWireResponse,
} from "../protocol-bridge.js";
import type { BrowserResult, GatewayError } from "@moat-browser/types";

// ---------------------------------------------------------------------------
// wireToCommand
// ---------------------------------------------------------------------------

describe("wireToCommand", () => {
  test("Navigate", () => {
    const cmd = wireToCommand({ id: "1", command: "Navigate", url: "https://example.com" });
    expect(cmd).toEqual({ _tag: "Navigate", url: "https://example.com" });
  });

  test("Navigate — missing url", () => {
    const err = wireToCommand({ id: "1", command: "Navigate" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("Click", () => {
    const cmd = wireToCommand({ id: "1", command: "Click", ref: "button#submit" });
    expect(cmd).toEqual({ _tag: "Click", ref: "button#submit" });
  });

  test("Click — missing ref", () => {
    const err = wireToCommand({ id: "1", command: "Click" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("Fill", () => {
    const cmd = wireToCommand({ id: "1", command: "Fill", ref: "#email", value: "a@b.com" });
    expect(cmd).toEqual({ _tag: "Fill", ref: "#email", value: "a@b.com" });
  });

  test("Fill — missing value", () => {
    const err = wireToCommand({ id: "1", command: "Fill", ref: "#email" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("Snapshot", () => {
    const cmd = wireToCommand({ id: "1", command: "Snapshot" });
    expect(cmd).toEqual({ _tag: "Snapshot" });
  });

  test("Screenshot", () => {
    const cmd = wireToCommand({ id: "1", command: "Screenshot" });
    expect(cmd).toEqual({ _tag: "Screenshot" });
  });

  test("Evaluate", () => {
    const cmd = wireToCommand({ id: "1", command: "Evaluate", expression: "document.title" });
    expect(cmd).toEqual({ _tag: "Evaluate", expression: "document.title" });
  });

  test("Evaluate — missing expression", () => {
    const err = wireToCommand({ id: "1", command: "Evaluate" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("NewTab — with url", () => {
    const cmd = wireToCommand({ id: "1", command: "NewTab", url: "https://example.com" });
    expect(cmd).toEqual({ _tag: "NewTab", url: "https://example.com" });
  });

  test("NewTab — without url", () => {
    const cmd = wireToCommand({ id: "1", command: "NewTab" });
    expect(cmd).toEqual({ _tag: "NewTab" });
  });

  test("SwitchTab", () => {
    const cmd = wireToCommand({ id: "1", command: "SwitchTab", tabId: "tab-1" });
    expect(cmd).toEqual({ _tag: "SwitchTab", tabId: "tab-1" });
  });

  test("SwitchTab — missing tabId", () => {
    const err = wireToCommand({ id: "1", command: "SwitchTab" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("CloseTab", () => {
    const cmd = wireToCommand({ id: "1", command: "CloseTab", tabId: "tab-1" });
    expect(cmd).toEqual({ _tag: "CloseTab", tabId: "tab-1" });
  });

  test("Wait", () => {
    const cmd = wireToCommand({ id: "1", command: "Wait", ms: 1000 });
    expect(cmd).toEqual({ _tag: "Wait", ms: 1000 });
  });

  test("Wait — missing ms", () => {
    const err = wireToCommand({ id: "1", command: "Wait" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("Unknown command", () => {
    const err = wireToCommand({ id: "1", command: "Unknown" });
    expect((err as GatewayError)._tag).toBe("ValidationError");
    const valErr = err as Extract<GatewayError, { _tag: "ValidationError" }>;
    expect(valErr.message).toContain("Unknown");
  });
});

// ---------------------------------------------------------------------------
// resultToWire — exhaustive coverage of all BrowserResult variants
// ---------------------------------------------------------------------------

describe("resultToWire", () => {
  const cases: Array<BrowserResult> = [
    { _tag: "NavigateResult", url: "https://example.com", title: "Example" },
    { _tag: "ClickResult", ref: "btn" },
    { _tag: "FillResult", ref: "#input" },
    { _tag: "SnapshotResult", snapshot: "<html/>" },
    { _tag: "ScreenshotResult", dataUrl: "data:image/png;base64,abc" },
    { _tag: "EvaluateResult", value: 42 },
    { _tag: "NewTabResult", tabId: "tab-1", url: "https://example.com" },
    { _tag: "SwitchTabResult", tabId: "tab-1" },
    { _tag: "CloseTabResult", tabId: "tab-1" },
    { _tag: "WaitResult", ms: 100 },
  ];

  for (const result of cases) {
    test(`${result._tag}`, () => {
      const wire = resultToWire("req-1", result);
      expect(wire.id).toBe("req-1");
      expect(wire.ok).toBe(true);
      expect(wire.result).toEqual(result);
    });
  }
});

// ---------------------------------------------------------------------------
// errorToWire
// ---------------------------------------------------------------------------

describe("errorToWire", () => {
  test("wraps GatewayError", () => {
    const err: GatewayError = { _tag: "AuthError", message: "bad token" };
    const wire = errorToWire("req-2", err);
    expect(wire.id).toBe("req-2");
    expect(wire.ok).toBe(false);
    expect(wire.error).toEqual(err);
  });
});

// ---------------------------------------------------------------------------
// parseWireLine
// ---------------------------------------------------------------------------

describe("parseWireLine", () => {
  test("valid line", () => {
    const req = parseWireLine('{"id":"1","command":"Navigate","url":"https://example.com"}');
    expect((req as { id: string }).id).toBe("1");
    expect((req as { command: string }).command).toBe("Navigate");
  });

  test("invalid JSON", () => {
    const err = parseWireLine("{bad json}");
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("missing id", () => {
    const err = parseWireLine('{"command":"Navigate"}');
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("missing command", () => {
    const err = parseWireLine('{"id":"1"}');
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });

  test("non-object JSON", () => {
    const err = parseWireLine('"just a string"');
    expect((err as GatewayError)._tag).toBe("ValidationError");
  });
});

// ---------------------------------------------------------------------------
// serializeWireResponse
// ---------------------------------------------------------------------------

describe("serializeWireResponse", () => {
  test("ok response ends with newline", () => {
    const result: BrowserResult = { _tag: "NavigateResult", url: "https://example.com", title: "Ex" };
    const wire = resultToWire("1", result);
    const serialized = serializeWireResponse(wire);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized.trimEnd())).toEqual(wire);
  });

  test("error response ends with newline", () => {
    const err: GatewayError = { _tag: "ValidationError", message: "bad" };
    const wire = errorToWire("1", err);
    const serialized = serializeWireResponse(wire);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized.trimEnd())).toEqual(wire);
  });
});
