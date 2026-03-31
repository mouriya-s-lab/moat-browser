import { describe, test, expect } from "bun:test";
import {
  BrowserCommandSchema,
  ClientEventSchema,
  RegisterEventSchema,
  CommandEventSchema,
  NavigateCommandSchema,
} from "../message-schemas.js";

describe("BrowserCommandSchema", () => {
  test("accepts Navigate with valid URL", () => {
    const r = BrowserCommandSchema({ _tag: "Navigate", url: "https://example.com" });
    expect(r).toEqual({ _tag: "Navigate", url: "https://example.com" });
  });

  test("rejects Navigate without protocol", () => {
    const r = BrowserCommandSchema({ _tag: "Navigate", url: "example.com" });
    expect(r instanceof Array).toBe(true);
  });

  test("accepts Click", () => {
    const r = BrowserCommandSchema({ _tag: "Click", ref: "#btn" });
    expect(r).toEqual({ _tag: "Click", ref: "#btn" });
  });

  test("accepts Fill", () => {
    const r = BrowserCommandSchema({ _tag: "Fill", ref: "#input", value: "hello" });
    expect(r).toEqual({ _tag: "Fill", ref: "#input", value: "hello" });
  });

  test("accepts Snapshot", () => {
    const r = BrowserCommandSchema({ _tag: "Snapshot" });
    expect(r).toEqual({ _tag: "Snapshot" });
  });

  test("accepts Screenshot", () => {
    const r = BrowserCommandSchema({ _tag: "Screenshot" });
    expect(r).toEqual({ _tag: "Screenshot" });
  });

  test("accepts Wait", () => {
    const r = BrowserCommandSchema({ _tag: "Wait", ms: 1000 });
    expect(r).toEqual({ _tag: "Wait", ms: 1000 });
  });

  test("rejects Wait with zero ms", () => {
    const r = BrowserCommandSchema({ _tag: "Wait", ms: 0 });
    expect(r instanceof Array).toBe(true);
  });

  test("accepts Evaluate", () => {
    const r = BrowserCommandSchema({ _tag: "Evaluate", expression: "document.title" });
    expect(r).toEqual({ _tag: "Evaluate", expression: "document.title" });
  });

  test("accepts GetCookies", () => {
    const r = BrowserCommandSchema({ _tag: "GetCookies" });
    expect(r).toEqual({ _tag: "GetCookies" });
  });

  test("accepts NewTab with url", () => {
    const r = BrowserCommandSchema({ _tag: "NewTab", url: "https://example.com" });
    expect(r).toEqual({ _tag: "NewTab", url: "https://example.com" });
  });

  test("accepts NewTab without url", () => {
    const r = BrowserCommandSchema({ _tag: "NewTab" });
    expect(r).toEqual({ _tag: "NewTab" });
  });

  test("accepts SwitchTab", () => {
    const r = BrowserCommandSchema({ _tag: "SwitchTab", tabName: "tab-1" });
    expect(r).toEqual({ _tag: "SwitchTab", tabName: "tab-1" });
  });

  test("accepts CloseTab", () => {
    const r = BrowserCommandSchema({ _tag: "CloseTab", tabName: "tab-1" });
    expect(r).toEqual({ _tag: "CloseTab", tabName: "tab-1" });
  });

  test("rejects unknown command", () => {
    const r = BrowserCommandSchema({ _tag: "Unknown" });
    expect(r instanceof Array).toBe(true);
  });
});

describe("ClientEventSchema", () => {
  test("accepts Register", () => {
    const r = ClientEventSchema({
      _tag: "Register",
      agentId: "agent-01",
      profile: "corp-sf",
      token: "abc",
    });
    expect((r as { _tag: string })._tag).toBe("Register");
  });

  test("accepts Command with nested BrowserCommand", () => {
    const r = ClientEventSchema({
      _tag: "Command",
      sessionId: "sess-1",
      command: { _tag: "Navigate", url: "https://example.com" },
    });
    expect((r as { _tag: string })._tag).toBe("Command");
  });

  test("rejects Command with invalid nested command", () => {
    const r = ClientEventSchema({
      _tag: "Command",
      sessionId: "sess-1",
      command: { _tag: "Navigate", url: "bad-url" },
    });
    expect(r instanceof Array).toBe(true);
  });

  test("accepts Ping", () => {
    const r = ClientEventSchema({ _tag: "Ping" });
    expect(r).toEqual({ _tag: "Ping" });
  });

  test("accepts ListProfiles", () => {
    const r = ClientEventSchema({ _tag: "ListProfiles" });
    expect(r).toEqual({ _tag: "ListProfiles" });
  });
});
