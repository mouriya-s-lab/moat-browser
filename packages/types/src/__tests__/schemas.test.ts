import { describe, test, expect } from "bun:test";
import {
  BrowserCommandSchema,
  RegisterEventSchema,
  ResumeEventSchema,
  DeregisterEventSchema,
  TokenPayloadSchema,
} from "../schemas.js";

describe("BrowserCommandSchema", () => {
  test("Navigate valid", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate", url: "https://example.com" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Click valid", () => {
    const result = BrowserCommandSchema({ _tag: "Click", ref: "button-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Fill valid", () => {
    const result = BrowserCommandSchema({ _tag: "Fill", ref: "input-1", value: "hello" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Snapshot valid", () => {
    const result = BrowserCommandSchema({ _tag: "Snapshot" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Screenshot valid", () => {
    const result = BrowserCommandSchema({ _tag: "Screenshot" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Evaluate valid", () => {
    const result = BrowserCommandSchema({ _tag: "Evaluate", expression: "document.title" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("NewTab valid", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab", url: "https://example.com" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("NewTab without url valid", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("SwitchTab valid", () => {
    const result = BrowserCommandSchema({ _tag: "SwitchTab", tabId: "tab-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("CloseTab valid", () => {
    const result = BrowserCommandSchema({ _tag: "CloseTab", tabId: "tab-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Wait valid", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", ms: 1000 });
    expect(result instanceof type.errors).toBe(false);
  });

  test("unknown _tag invalid", () => {
    const result = BrowserCommandSchema({ _tag: "Unknown", foo: "bar" });
    expect(result instanceof type.errors).toBe(true);
  });

  test("missing required field invalid", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate" });
    expect(result instanceof type.errors).toBe(true);
  });

  test("wrong type for url invalid", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate", url: 42 });
    expect(result instanceof type.errors).toBe(true);
  });

  test("Click missing ref invalid", () => {
    const result = BrowserCommandSchema({ _tag: "Click" });
    expect(result instanceof type.errors).toBe(true);
  });

  test("Wait with string ms invalid", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", ms: "1000" });
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("RegisterEventSchema", () => {
  test("valid agentId", () => {
    const result = RegisterEventSchema({ agentId: "agent-123" });
    expect(result instanceof type.errors).toBe(false);
    if (!(result instanceof type.errors)) {
      expect(result.agentId).toBe("agent-123");
    }
  });

  test("missing agentId invalid", () => {
    const result = RegisterEventSchema({});
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("ResumeEventSchema", () => {
  test("valid sessionId", () => {
    const result = ResumeEventSchema({ sessionId: "session-abc" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("missing sessionId invalid", () => {
    const result = ResumeEventSchema({});
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("DeregisterEventSchema", () => {
  test("valid sessionId", () => {
    const result = DeregisterEventSchema({ sessionId: "session-xyz" });
    expect(result instanceof type.errors).toBe(false);
  });
});

describe("TokenPayloadSchema", () => {
  test("valid full payload", () => {
    const result = TokenPayloadSchema({ agentId: "agent-1", iat: 1000, exp: 2000, iss: "moat" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("valid without optional iss", () => {
    const result = TokenPayloadSchema({ agentId: "agent-1", iat: 1000, exp: 2000 });
    expect(result instanceof type.errors).toBe(false);
  });

  test("missing agentId invalid", () => {
    const result = TokenPayloadSchema({ iat: 1000, exp: 2000 });
    expect(result instanceof type.errors).toBe(true);
  });

  test("missing exp invalid", () => {
    const result = TokenPayloadSchema({ agentId: "agent-1", iat: 1000 });
    expect(result instanceof type.errors).toBe(true);
  });
});

// Import type to help with isinstance check
import { type } from "arktype";
