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

  test("command — scroll with selector", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "scroll", direction: "down", amount: 500, selector: "#scroll-container" },
    });
    expect(result).toEqual({
      type: "command",
      sessionId: "s1",
      command: { action: "scroll", direction: "down", amount: 500, selector: "#scroll-container" },
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

  test("command — pushstate", () => {
    const command = { action: "pushstate", url: "/dashboard" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — addinitscript", () => {
    const command = { action: "addinitscript", script: "window.__moat = 1" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — removeinitscript", () => {
    const command = { action: "removeinitscript", identifier: "init-abc" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — getbytext forwards value for value-taking subactions", () => {
    const command = { action: "getbytext", text: "Editable", subaction: "fill", value: "hello" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — each locator accepts its contract subaction set", () => {
    const commands = [
      { action: "getbyrole", role: "checkbox", subaction: "uncheck" },
      { action: "getbyrole", role: "heading", subaction: "text" },
      { action: "getbylabel", label: "Name", subaction: "uncheck" },
      { action: "getbyplaceholder", placeholder: "Notes", subaction: "check" },
      { action: "getbyplaceholder", placeholder: "Notes", subaction: "hover" },
      { action: "getbytext", text: "Probe", subaction: "text" },
      { action: "getbyalttext", text: "Alt", subaction: "check" },
      { action: "getbytitle", text: "Title", subaction: "hover" },
      { action: "getbytestid", testId: "notes", subaction: "type" },
    ];
    for (const command of commands) {
      const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
      expect(result).not.toBeInstanceOf(type.errors);
    }
  });

  test("command — route with resource type filter", () => {
    const command = { action: "route", url: "**/json", abort: false, body: "{}", resourceType: "XHR, Fetch" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — snapshot with URLs", () => {
    const command = { action: "snapshot", interactive: true, selector: "body", urls: true };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — har_start content mode", () => {
    const command = { action: "har_start", content: "all" };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
  });

  test("command — type with clear and delay", () => {
    const command = { action: "type", selector: "#input", text: "ab", clear: true, delay: 300 };
    const result = wireRequestSchema({ type: "command", sessionId: "s1", command });
    expect(result).toEqual({ type: "command", sessionId: "s1", command });
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

  test("type rejects negative delay", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "type", selector: "#input", text: "ab", delay: -1 },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("getbyrole rejects null name instead of widening optional string", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "getbyrole", role: "heading", name: null },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("getbytext rejects the type subaction it does not support", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "getbytext", text: "x", subaction: "type", value: "y" },
    });
    expect(result).toBeInstanceOf(type.errors);
  });

  test("getbyplaceholder rejects the uncheck subaction it does not support", () => {
    const result = wireRequestSchema({
      type: "command",
      sessionId: "s1",
      command: { action: "getbyplaceholder", placeholder: "x", subaction: "uncheck" },
    });
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
