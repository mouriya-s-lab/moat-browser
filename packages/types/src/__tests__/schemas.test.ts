import { describe, test, expect } from "bun:test";
import {
  CreateAgentBrowserSchema,
  DestroyAgentBrowserSchema,
  ListAgentBrowsersSchema,
  StartUserChromeSchema,
  FreezeProfileSchema,
  DeleteProfileSchema,
  HealthCheckSchema,
  ControllerRequestSchema,
  ContainerInfoSchema,
  ProfileInfoSchema,
} from "../schemas.js";

describe("CreateAgentBrowserSchema", () => {
  test("accepts valid input", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "agent-01",
      profileName: "corp-sf",
    });
    expect(result).toEqual({
      _tag: "CreateAgentBrowser",
      agentId: "agent-01",
      profileName: "corp-sf",
    });
  });

  test("rejects invalid agentId — uppercase", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "INVALID",
      profileName: "ok-name",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects invalid agentId — special chars", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "bad!!id",
      profileName: "ok-name",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects single char agentId", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "a",
      profileName: "ok-name",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("accepts two-char agentId", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "ab",
      profileName: "ok",
    });
    expect(result).toEqual({
      _tag: "CreateAgentBrowser",
      agentId: "ab",
      profileName: "ok",
    });
  });

  test("rejects agentId starting with hyphen", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "-bad",
      profileName: "ok-name",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects empty agentId", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "CreateAgentBrowser",
      agentId: "",
      profileName: "ok-name",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects wrong _tag", () => {
    const result = CreateAgentBrowserSchema({
      _tag: "WrongTag",
      agentId: "agent-01",
      profileName: "corp-sf",
    });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects missing fields", () => {
    const result = CreateAgentBrowserSchema({ _tag: "CreateAgentBrowser" });
    expect(result instanceof Array).toBe(true);
  });
});

describe("DestroyAgentBrowserSchema", () => {
  test("accepts valid input", () => {
    const result = DestroyAgentBrowserSchema({
      _tag: "DestroyAgentBrowser",
      agentId: "agent-01",
    });
    expect(result).toEqual({ _tag: "DestroyAgentBrowser", agentId: "agent-01" });
  });
});

describe("ListAgentBrowsersSchema", () => {
  test("accepts valid input", () => {
    const result = ListAgentBrowsersSchema({ _tag: "ListAgentBrowsers" });
    expect(result).toEqual({ _tag: "ListAgentBrowsers" });
  });
});

describe("StartUserChromeSchema", () => {
  test("accepts valid input", () => {
    const result = StartUserChromeSchema({
      _tag: "StartUserChrome",
      profileName: "my-profile",
    });
    expect(result).toEqual({ _tag: "StartUserChrome", profileName: "my-profile" });
  });
});

describe("FreezeProfileSchema", () => {
  test("accepts valid input", () => {
    const result = FreezeProfileSchema({
      _tag: "FreezeProfile",
      profileName: "my-profile",
    });
    expect(result).toEqual({ _tag: "FreezeProfile", profileName: "my-profile" });
  });
});

describe("ControllerRequestSchema (union)", () => {
  test("matches ListProfiles", () => {
    const result = ControllerRequestSchema({ _tag: "ListProfiles" });
    expect(result).toEqual({ _tag: "ListProfiles" });
  });

  test("matches StopUserChrome", () => {
    const result = ControllerRequestSchema({ _tag: "StopUserChrome" });
    expect(result).toEqual({ _tag: "StopUserChrome" });
  });

  test("matches HealthCheck", () => {
    const result = ControllerRequestSchema({
      _tag: "HealthCheck",
      agentId: "agent-01",
    });
    expect(result).toEqual({ _tag: "HealthCheck", agentId: "agent-01" });
  });

  test("rejects unknown _tag", () => {
    const result = ControllerRequestSchema({ _tag: "Unknown" });
    expect(result instanceof Array).toBe(true);
  });

  test("rejects non-object", () => {
    const result = ControllerRequestSchema("not an object");
    expect(result instanceof Array).toBe(true);
  });

  test("rejects null", () => {
    const result = ControllerRequestSchema(null);
    expect(result instanceof Array).toBe(true);
  });
});

describe("ContainerInfoSchema", () => {
  test("accepts valid container info", () => {
    const result = ContainerInfoSchema({
      containerId: "abc123",
      agentId: "agent-01",
      profileName: "corp-sf",
      state: "running",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(result).toEqual({
      containerId: "abc123",
      agentId: "agent-01",
      profileName: "corp-sf",
      state: "running",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  test("accepts with optional socketPath", () => {
    const result = ContainerInfoSchema({
      containerId: "abc123",
      agentId: "agent-01",
      profileName: "corp-sf",
      state: "creating",
      createdAt: "2026-01-01T00:00:00Z",
      socketPath: "/run/agent-browser/main.sock",
    });
    expect((result as { socketPath: string }).socketPath).toBe("/run/agent-browser/main.sock");
  });

  test("rejects invalid state", () => {
    const result = ContainerInfoSchema({
      containerId: "abc123",
      agentId: "agent-01",
      profileName: "corp-sf",
      state: "invalid",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(result instanceof Array).toBe(true);
  });
});

describe("ProfileInfoSchema", () => {
  test("accepts valid profile info", () => {
    const result = ProfileInfoSchema({
      name: "corp-sf",
      frozen: true,
      frozenAt: "2026-01-01T00:00:00Z",
      sizeBytes: 1024,
    });
    expect(result).toEqual({
      name: "corp-sf",
      frozen: true,
      frozenAt: "2026-01-01T00:00:00Z",
      sizeBytes: 1024,
    });
  });

  test("rejects non-boolean frozen", () => {
    const result = ProfileInfoSchema({
      name: "corp-sf",
      frozen: "yes",
      sizeBytes: 1024,
    });
    expect(result instanceof Array).toBe(true);
  });
});
