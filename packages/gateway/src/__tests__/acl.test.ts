import { describe, test, expect, beforeEach } from "bun:test";
import { configureAcl, checkUrl } from "../acl.js";

describe("ACL", () => {
  beforeEach(() => {
    configureAcl([]); // Reset to allow-all
  });

  test("allows all when no domains configured", () => {
    const result = checkUrl("https://example.com");
    expect(result).toBeNull();
  });

  test("allows exact domain match", () => {
    configureAcl(["example.com"]);
    expect(checkUrl("https://example.com/page")).toBeNull();
  });

  test("allows subdomain match", () => {
    configureAcl(["example.com"]);
    expect(checkUrl("https://sub.example.com/page")).toBeNull();
  });

  test("blocks non-matching domain", () => {
    configureAcl(["example.com"]);
    const result = checkUrl("https://evil.com/page");
    expect(result).not.toBeNull();
    expect(result?._tag).toBe("DomainBlocked");
    expect(result && "domain" in result ? result.domain : "").toBe("evil.com");
  });

  test("blocks partial domain match (not subdomain)", () => {
    configureAcl(["example.com"]);
    const result = checkUrl("https://notexample.com");
    expect(result).not.toBeNull();
  });

  test("handles multiple allowed domains", () => {
    configureAcl(["example.com", "google.com"]);
    expect(checkUrl("https://example.com")).toBeNull();
    expect(checkUrl("https://google.com")).toBeNull();
    expect(checkUrl("https://evil.com")).not.toBeNull();
  });

  test("is case insensitive", () => {
    configureAcl(["Example.COM"]);
    expect(checkUrl("https://EXAMPLE.com/page")).toBeNull();
  });

  test("handles invalid URL", () => {
    configureAcl(["example.com"]);
    const result = checkUrl("not-a-url");
    expect(result).not.toBeNull();
    expect(result?._tag).toBe("DomainBlocked");
  });
});
