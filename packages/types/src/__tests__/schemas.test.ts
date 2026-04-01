import { describe, it, expect } from "bun:test";
import { type } from "arktype";
import {
  BrowserCommandSchema,
  TokenPayloadSchema,
  RegisterPayloadSchema,
  DeregisterPayloadSchema,
} from "../schemas.js";

// ---- BrowserCommand schema ----

describe("BrowserCommandSchema", () => {
  it("Navigate: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate", url: "https://example.com" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Click: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Click", ref: "button-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Fill: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Fill", ref: "input-1", value: "hello" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Snapshot: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Snapshot" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Screenshot: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Screenshot" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Evaluate: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Evaluate", expression: "document.title" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("NewTab: valid without url", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("NewTab: valid with url", () => {
    const result = BrowserCommandSchema({ _tag: "NewTab", url: "https://example.com" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("SwitchTab: valid", () => {
    const result = BrowserCommandSchema({ _tag: "SwitchTab", tabName: "My Tab" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("CloseTab: valid", () => {
    const result = BrowserCommandSchema({ _tag: "CloseTab", tabName: "My Tab" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("Wait: valid", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", ms: 1000 });
    expect(result instanceof type.errors).toBe(false);
  });

  it("unknown _tag → error", () => {
    const result = BrowserCommandSchema({ _tag: "Unknown", url: "https://example.com" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("Navigate missing url → error", () => {
    const result = BrowserCommandSchema({ _tag: "Navigate" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("Click missing ref → error", () => {
    const result = BrowserCommandSchema({ _tag: "Click" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("Wait with string ms → error", () => {
    const result = BrowserCommandSchema({ _tag: "Wait", ms: "1000" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("null input → error", () => {
    const result = BrowserCommandSchema(null);
    expect(result instanceof type.errors).toBe(true);
  });
});

// ---- TokenPayload schema ----

describe("TokenPayloadSchema", () => {
  const valid = {
    sub: "agent-1",
    iss: "moat-browser",
    aud: "moat-browser-controller",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };

  it("valid payload passes", () => {
    const result = TokenPayloadSchema(valid);
    expect(result instanceof type.errors).toBe(false);
  });

  it("wrong iss → error", () => {
    const result = TokenPayloadSchema({ ...valid, iss: "other-service" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("wrong aud → error", () => {
    const result = TokenPayloadSchema({ ...valid, aud: "other-audience" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("missing sub → error", () => {
    const { sub: _, ...rest } = valid;
    const result = TokenPayloadSchema(rest);
    expect(result instanceof type.errors).toBe(true);
  });

  it("missing exp → error", () => {
    const { exp: _, ...rest } = valid;
    const result = TokenPayloadSchema(rest);
    expect(result instanceof type.errors).toBe(true);
  });

  it("exp as string → error", () => {
    const result = TokenPayloadSchema({ ...valid, exp: String(valid.exp) });
    expect(result instanceof type.errors).toBe(true);
  });
});

// ---- Socket.IO payload schemas ----

describe("RegisterPayloadSchema", () => {
  it("valid", () => {
    const result = RegisterPayloadSchema({ agentId: "agent-1" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("missing agentId → error", () => {
    const result = RegisterPayloadSchema({});
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("DeregisterPayloadSchema", () => {
  it("valid", () => {
    const result = DeregisterPayloadSchema({ sessionId: "sess-xyz" });
    expect(result instanceof type.errors).toBe(false);
  });

  it("missing sessionId → error", () => {
    const result = DeregisterPayloadSchema({});
    expect(result instanceof type.errors).toBe(true);
  });
});
