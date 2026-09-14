import { describe, expect, test } from "bun:test";
import { wireRequestSchema, exhaustive, ErrorCode } from "../src/index";
import type { ArkErrors } from "arktype";

describe("wireRequestSchema — valid requests", () => {
  test("register without profile", () => {
    const result = wireRequestSchema({ type: "register" });
    expect(result).toEqual({ type: "register" });
  });

  test("register with profile", () => {
    const result = wireRequestSchema({ type: "register", profile: "default" });
    expect(result).toEqual({ type: "register", profile: "default" });
  });

  test("deregister", () => {
    const result = wireRequestSchema({ type: "deregister", sessionId: "abc-123" });
    expect(result).toEqual({ type: "deregister", sessionId: "abc-123" });
  });

  test("command — navigate", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "navigate", url: "https://example.com" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "navigate", url: "https://example.com" },
    });
  });

  test("command — getbyrole with subaction", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "getbyrole", role: "button", name: "Submit", subaction: "click" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "getbyrole", role: "button", name: "Submit", subaction: "click" },
    });
  });

  test("command — snapshot", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "snapshot" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "snapshot" },
    });
  });

  test("command — scroll", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "scroll", direction: "down", amount: 500 },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "scroll", direction: "down", amount: 500 },
    });
  });

  test("command — tab_list", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "tab_list" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "tab_list" },
    });
  });

  test("command — cookies_get", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "cookies_get", url: "https://example.com" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "cookies_get", url: "https://example.com" },
    });
  });

  test("command — fill with ref", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "fill", ref: "@e1", value: "hello" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "fill", ref: "@e1", value: "hello" },
    });
  });

  test("command — eval", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "eval", code: "document.title" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "eval", code: "document.title" },
    });
  });
});

describe("wireRequestSchema — invalid requests", () => {
  test("missing type field", () => {
    const result = wireRequestSchema({});
    expect(result).toBeInstanceOf(type.errors);
  });

  test("invalid type value", () => {
    const result = wireRequestSchema({ type: "invalid" });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("legacy resume is rejected because commands resume by sessionId", () => {
    const result = wireRequestSchema({ type: "resume", sessionId: "abc-123" });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("command missing sessionId", () => {
    const result = wireRequestSchema({ type: "command", command: { action: "snapshot" } });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("command missing command field", () => {
    const result = wireRequestSchema({ type: "command", sessionId: "s1" });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("command with invalid action", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "nonexistent" },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("navigate missing url", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "navigate" },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("scroll with invalid direction", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "scroll", direction: "diagonal" },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("non-object input", () => {
    const result = wireRequestSchema("not an object");
    expect(result).toBeInstanceOf(type.errors);
  });

  test("null input", () => {
    const result = wireRequestSchema(null);
    expect(result).toBeInstanceOf(type.errors);
  });
});

describe("exhaustive", () => {
  test("throws on any value", () => {
    expect(() => exhaustive("x" as never)).toThrow("Unhandled discriminant");
  });
});

describe("ErrorCode", () => {
  test("maps all 12 ControllerError tags", () => {
    expect(Object.keys(ErrorCode)).toHaveLength(12);
    expect(ErrorCode.SessionNotFound).toBe(77);
    expect(ErrorCode.SessionExpired).toBe(83);
    expect(ErrorCode.ContainerCreateFailed).toBe(80);
    expect(ErrorCode.CdpUnreachable).toBe(81);
    expect(ErrorCode.CdpDisconnected).toBe(81);
    expect(ErrorCode.ProfileCopyFailed).toBe(82);
    expect(ErrorCode.ElementNotFound).toBe(66);
    expect(ErrorCode.Timeout).toBe(75);
    expect(ErrorCode.CommandFailed).toBe(1);
    expect(ErrorCode.ValidationFailed).toBe(2);
    expect(ErrorCode.CapacityExceeded).toBe(84);
  });
});

// We need to import type to use type.errors
import { type } from "arktype";
