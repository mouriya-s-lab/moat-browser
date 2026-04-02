import { describe, expect, it } from "bun:test";
import { BrowserCommandSchema, BrowserResultSchema, GatewayErrorSchema } from "../schemas";

describe("BrowserCommandSchema", () => {
  it("validates Navigate", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate", url: "https://example.com" });
    expect(result).toEqual({ _tag: "Navigate", url: "https://example.com" });
  });

  it("validates Click", () => {
    const result = BrowserCommandSchema({ _tag: "Click", selector: "#btn" });
    expect(result).toEqual({ _tag: "Click", selector: "#btn" });
  });

  it("validates Fill", () => {
    const result = BrowserCommandSchema({ _tag: "Fill", selector: "#input", value: "hello" });
    expect(result).toEqual({ _tag: "Fill", selector: "#input", value: "hello" });
  });

  it("validates Snapshot", () => {
    const result = BrowserCommandSchema({ _tag: "Snapshot" });
    expect(result).toEqual({ _tag: "Snapshot" });
  });

  it("validates Screenshot", () => {
    const result = BrowserCommandSchema({ _tag: "Screenshot" });
    expect(result).toEqual({ _tag: "Screenshot" });
  });

  it("validates Evaluate", () => {
    const result = BrowserCommandSchema({ _tag: "Evaluate", expression: "1+1" });
    expect(result).toEqual({ _tag: "Evaluate", expression: "1+1" });
  });

  it("validates NewTab without url", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab" });
    expect(result).toEqual({ _tag: "NewTab" });
  });

  it("validates NewTab with url", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab", url: "https://example.com" });
    expect(result).toEqual({ _tag: "NewTab", url: "https://example.com" });
  });

  it("validates SwitchTab", () => {
    const result = BrowserCommandSchema({ _tag: "SwitchTab", index: 0 });
    expect(result).toEqual({ _tag: "SwitchTab", index: 0 });
  });

  it("validates CloseTab", () => {
    const result = BrowserCommandSchema({ _tag: "CloseTab", index: 1 });
    expect(result).toEqual({ _tag: "CloseTab", index: 1 });
  });

  it("validates Wait with timeout", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", selector: "#el", timeout: 5000 });
    expect(result).toEqual({ _tag: "Wait", selector: "#el", timeout: 5000 });
  });

  it("validates Wait without timeout", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", selector: "#el" });
    expect(result).toEqual({ _tag: "Wait", selector: "#el" });
  });

  it("rejects invalid _tag", () => {
    const result = BrowserCommandSchema({ _tag: "Invalid" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects Navigate without url", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects empty object", () => {
    const result = BrowserCommandSchema({});
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("BrowserResultSchema", () => {
  it("validates NavigateResult", () => {
    const result = BrowserResultSchema({ _tag: "NavigateResult", url: "https://example.com", title: "Example" });
    expect(result).toEqual({ _tag: "NavigateResult", url: "https://example.com", title: "Example" });
  });

  it("validates ClickResult", () => {
    const result = BrowserResultSchema({ _tag: "ClickResult" });
    expect(result).toEqual({ _tag: "ClickResult" });
  });

  it("validates SnapshotResult", () => {
    const result = BrowserResultSchema({ _tag: "SnapshotResult", aria: "<tree>" });
    expect(result).toEqual({ _tag: "SnapshotResult", aria: "<tree>" });
  });

  it("validates ScreenshotResult", () => {
    const result = BrowserResultSchema({ _tag: "ScreenshotResult", png: "iVBOR..." });
    expect(result).toEqual({ _tag: "ScreenshotResult", png: "iVBOR..." });
  });

  it("validates EvaluateResult", () => {
    const result = BrowserResultSchema({ _tag: "EvaluateResult", value: 42 });
    expect(result).toEqual({ _tag: "EvaluateResult", value: 42 });
  });

  it("validates TabResult", () => {
    const result = BrowserResultSchema({
      _tag: "TabResult",
      tabs: [{ index: 0, url: "https://example.com", title: "Example" }],
    });
    expect(result).toEqual({
      _tag: "TabResult",
      tabs: [{ index: 0, url: "https://example.com", title: "Example" }],
    });
  });

  it("validates WaitResult", () => {
    const result = BrowserResultSchema({ _tag: "WaitResult" });
    expect(result).toEqual({ _tag: "WaitResult" });
  });
});

describe("GatewayErrorSchema", () => {
  it("validates AuthError", () => {
    const result = GatewayErrorSchema({ _tag: "AuthError", message: "invalid token" });
    expect(result).toEqual({ _tag: "AuthError", message: "invalid token" });
  });

  it("validates SessionNotFound", () => {
    const result = GatewayErrorSchema({ _tag: "SessionNotFound", sessionId: "abc" });
    expect(result).toEqual({ _tag: "SessionNotFound", sessionId: "abc" });
  });

  it("validates SessionExpired", () => {
    const result = GatewayErrorSchema({ _tag: "SessionExpired", sessionId: "abc" });
    expect(result).toEqual({ _tag: "SessionExpired", sessionId: "abc" });
  });

  it("validates CommandError", () => {
    const result = GatewayErrorSchema({ _tag: "CommandError", command: "Navigate", message: "failed" });
    expect(result).toEqual({ _tag: "CommandError", command: "Navigate", message: "failed" });
  });

  it("validates ContainerError", () => {
    const result = GatewayErrorSchema({ _tag: "ContainerError", message: "create failed" });
    expect(result).toEqual({ _tag: "ContainerError", message: "create failed" });
  });

  it("validates ValidationError", () => {
    const result = GatewayErrorSchema({ _tag: "ValidationError", message: "bad input" });
    expect(result).toEqual({ _tag: "ValidationError", message: "bad input" });
  });
});

// Import type to check errors
import { type } from "arktype";
