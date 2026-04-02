import { describe, test, expect } from "bun:test";
import { validateBrowserCommand } from "../schemas";

describe("validateBrowserCommand", () => {
  test("validates Navigate command", () => {
    const result = validateBrowserCommand({ _tag: "Navigate", url: "https://example.com" });
    expect(result._tag).toBe("Navigate");
    if (result._tag !== "ValidationError") {
      expect(result).toEqual({ _tag: "Navigate", url: "https://example.com" });
    }
  });

  test("validates Click command", () => {
    const result = validateBrowserCommand({ _tag: "Click", selector: "#btn" });
    expect(result._tag).toBe("Click");
  });

  test("validates Fill command", () => {
    const result = validateBrowserCommand({ _tag: "Fill", selector: "#input", value: "hello" });
    expect(result._tag).toBe("Fill");
  });

  test("validates Snapshot command", () => {
    const result = validateBrowserCommand({ _tag: "Snapshot" });
    expect(result._tag).toBe("Snapshot");
  });

  test("validates Screenshot command", () => {
    const result = validateBrowserCommand({ _tag: "Screenshot" });
    expect(result._tag).toBe("Screenshot");
  });

  test("validates Evaluate command", () => {
    const result = validateBrowserCommand({ _tag: "Evaluate", expression: "1+1" });
    expect(result._tag).toBe("Evaluate");
  });

  test("validates NewTab without url", () => {
    const result = validateBrowserCommand({ _tag: "NewTab" });
    expect(result._tag).toBe("NewTab");
  });

  test("validates NewTab with url", () => {
    const result = validateBrowserCommand({ _tag: "NewTab", url: "https://example.com" });
    expect(result._tag).toBe("NewTab");
  });

  test("validates SwitchTab command", () => {
    const result = validateBrowserCommand({ _tag: "SwitchTab", index: 0 });
    expect(result._tag).toBe("SwitchTab");
  });

  test("validates CloseTab command", () => {
    const result = validateBrowserCommand({ _tag: "CloseTab", index: 1 });
    expect(result._tag).toBe("CloseTab");
  });

  test("validates Wait without timeout", () => {
    const result = validateBrowserCommand({ _tag: "Wait", selector: "#el" });
    expect(result._tag).toBe("Wait");
  });

  test("validates Wait with timeout", () => {
    const result = validateBrowserCommand({ _tag: "Wait", selector: "#el", timeout: 5000 });
    expect(result._tag).toBe("Wait");
  });

  test("rejects missing _tag", () => {
    const result = validateBrowserCommand({ url: "https://example.com" });
    expect(result._tag).toBe("ValidationError");
  });

  test("rejects unknown _tag", () => {
    const result = validateBrowserCommand({ _tag: "Unknown" });
    expect(result._tag).toBe("ValidationError");
  });

  test("rejects wrong type for url", () => {
    const result = validateBrowserCommand({ _tag: "Navigate", url: 123 });
    expect(result._tag).toBe("ValidationError");
  });

  test("rejects missing required field", () => {
    const result = validateBrowserCommand({ _tag: "Click" });
    expect(result._tag).toBe("ValidationError");
  });

  test("rejects non-object input", () => {
    expect(validateBrowserCommand(null)._tag).toBe("ValidationError");
    expect(validateBrowserCommand(undefined)._tag).toBe("ValidationError");
    expect(validateBrowserCommand("string")._tag).toBe("ValidationError");
    expect(validateBrowserCommand(42)._tag).toBe("ValidationError");
  });
});
