import { MoatBrowserClient, type ShimConfig } from "@moat-browser/shim";
import type { BrowserResult, GatewayError } from "@moat-browser/types";

export function assertResult<Tag extends BrowserResult["_tag"]>(
  result: BrowserResult,
  tag: Tag,
): Extract<BrowserResult, { _tag: Tag }> {
  if (result._tag !== tag) {
    throw new Error(`Expected ${tag}, got ${result._tag}: ${JSON.stringify(result)}`);
  }
  return result as Extract<BrowserResult, { _tag: Tag }>;
}

export function assertError<Tag extends GatewayError["_tag"]>(
  error: GatewayError,
  tag: Tag,
): Extract<GatewayError, { _tag: Tag }> {
  if (error._tag !== tag) {
    throw new Error(`Expected error ${tag}, got ${error._tag}: ${JSON.stringify(error)}`);
  }
  return error as Extract<GatewayError, { _tag: Tag }>;
}

export function createTestClient(overrides?: Partial<ShimConfig>): MoatBrowserClient {
  const agentId = overrides?.agentId ?? `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return new MoatBrowserClient({
    gateway: process.env["MOAT_TEST_GATEWAY"] ?? "ws://localhost:9800",
    token: overrides?.token ?? "test-token",
    agentId,
    profile: overrides?.profile ?? "test-profile",
    ...overrides,
  });
}

export async function waitForPort(
  port: number,
  opts?: { host?: string; timeout?: number },
): Promise<void> {
  const host = opts?.host ?? "localhost";
  const timeout = opts?.timeout ?? 30_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/`);
      if (res.ok || res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for ${host}:${port}`);
}

export async function waitForHealth(
  url: string,
  opts?: { timeout?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 30_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for ${url}`);
}
