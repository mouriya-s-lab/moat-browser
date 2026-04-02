import { describe, expect, it } from "bun:test";
import { BrowserCommandSchema, GatewayErrorSchema } from "@moat-browser/types";
import { type } from "arktype";

function isError(result: unknown): boolean {
  return result instanceof type.errors;
}

describe("BrowserCommandSchema integration", () => {
  it("validates Navigate from raw input", () => {
    const input = JSON.parse('{"_tag":"Navigate","url":"https://example.com"}');
    const result = BrowserCommandSchema(input);
    expect(result).toEqual({ _tag: "Navigate", url: "https://example.com" });
  });

  it("rejects command with wrong _tag", () => {
    const result = BrowserCommandSchema({ _tag: "DoSomething" });
    expect(isError(result)).toBe(true);
  });

  it("rejects command with missing required field", () => {
    const result = BrowserCommandSchema({ _tag: "Fill", selector: "#input" });
    expect(isError(result)).toBe(true);
  });

  it("validates all command types", () => {
    const commands = [
      { _tag: "Navigate", url: "https://x.com" },
      { _tag: "Click", selector: "#btn" },
      { _tag: "Fill", selector: "#in", value: "v" },
      { _tag: "Snapshot" },
      { _tag: "Screenshot" },
      { _tag: "Evaluate", expression: "1" },
      { _tag: "NewTab" },
      { _tag: "SwitchTab", index: 0 },
      { _tag: "CloseTab", index: 0 },
      { _tag: "Wait", selector: "#el" },
    ];

    for (const cmd of commands) {
      const result = BrowserCommandSchema(cmd);
      expect(isError(result)).toBe(false);
    }
  });
});

describe("GatewayErrorSchema integration", () => {
  it("validates all error types", () => {
    const errors = [
      { _tag: "AuthError", message: "bad" },
      { _tag: "SessionNotFound", sessionId: "x" },
      { _tag: "SessionExpired", sessionId: "x" },
      { _tag: "CommandError", command: "Navigate", message: "failed" },
      { _tag: "ContainerError", message: "failed" },
      { _tag: "ValidationError", message: "bad" },
    ];

    for (const err of errors) {
      const result = GatewayErrorSchema(err);
      expect(isError(result)).toBe(false);
    }
  });
});
