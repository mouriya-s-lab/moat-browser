// Docker Engine API via fetch + Unix socket (design.md §4.6)
// No dockerode — uses Bun's native fetch with unix socket option
import type { GatewayError } from "@moat-browser/types";
import { config } from "./config.js";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Low-level fetch helper for Docker Engine API
async function dockerFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...options,
    // @ts-expect-error — Bun-specific unix socket option
    unix: config.dockerSocket,
  });
}

// POST /containers/create + POST /containers/{id}/start
// Returns {containerId, profilePath} or GatewayError
export async function createAgentChrome(
  agentId: string
): Promise<{ containerId: string; profilePath: string } | GatewayError> {
  // Copy profile: cp -a config.profileDir → config.agentProfilesDir/{agentId}-{uuid}/
  const profilePath = `${config.agentProfilesDir}/${agentId}-${randomUUID()}`;
  try {
    execSync(`cp -a "${config.profileDir}/." "${profilePath}/"`, { stdio: "pipe" });
  } catch (err) {
    return { _tag: "ContainerError", message: `Profile copy failed: ${String(err)}` };
  }

  // Create container
  let containerId: string;
  try {
    const createRes = await dockerFetch("/containers/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Image: config.agentChromeImage,
        HostConfig: {
          Binds: [`${profilePath}:/data/profile`],
          ShmSize: 2 * 1024 * 1024 * 1024, // 2GB
          NetworkMode: config.dockerNetwork,
        },
        ExposedPorts: { "9222/tcp": {} },
        Labels: {
          "moat-browser": "agent-chrome",
          "moat-browser.agent-id": agentId,
        },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      return { _tag: "ContainerError", message: `Create failed (${createRes.status}): ${text}` };
    }

    const created = (await createRes.json()) as { Id: string };
    containerId = created.Id;
  } catch (err) {
    return { _tag: "ContainerError", message: `Docker create error: ${String(err)}` };
  }

  // Start container
  try {
    const startRes = await dockerFetch(`/containers/${containerId}/start`, {
      method: "POST",
    });

    if (!startRes.ok && startRes.status !== 304) {
      const text = await startRes.text();
      return { _tag: "ContainerError", message: `Start failed (${startRes.status}): ${text}` };
    }
  } catch (err) {
    return { _tag: "ContainerError", message: `Docker start error: ${String(err)}` };
  }

  return { containerId, profilePath };
}

// POST /containers/{id}/stop + DELETE /containers/{id} + rm -rf profilePath
export async function destroyAgentChrome(
  containerId: string,
  profilePath: string
): Promise<true | GatewayError> {
  try {
    await dockerFetch(`/containers/${containerId}/stop?t=5`, { method: "POST" });
  } catch {
    // Ignore stop errors — container may already be stopped
  }

  try {
    const deleteRes = await dockerFetch(`/containers/${containerId}`, { method: "DELETE" });
    if (!deleteRes.ok && deleteRes.status !== 404) {
      const text = await deleteRes.text();
      return { _tag: "ContainerError", message: `Delete failed (${deleteRes.status}): ${text}` };
    }
  } catch (err) {
    return { _tag: "ContainerError", message: `Docker delete error: ${String(err)}` };
  }

  try {
    execSync(`rm -rf "${profilePath}"`, { stdio: "pipe" });
  } catch {
    // Best-effort profile cleanup — don't fail the destroy
  }

  return true;
}

// GET /containers/{id}/json → IP from NetworkSettings.Networks[dockerNetwork].IPAddress
export async function inspectContainer(
  containerId: string
): Promise<{ ip: string } | GatewayError> {
  try {
    const res = await dockerFetch(`/containers/${containerId}/json`);
    if (!res.ok) {
      const text = await res.text();
      return { _tag: "ContainerError", message: `Inspect failed (${res.status}): ${text}` };
    }

    const info = (await res.json()) as {
      NetworkSettings: {
        Networks: Record<string, { IPAddress: string } | undefined>;
      };
    };

    const network = info.NetworkSettings.Networks[config.dockerNetwork];
    if (!network) {
      return {
        _tag: "ContainerError",
        message: `Container not on network ${config.dockerNetwork}`,
      };
    }

    return { ip: network.IPAddress };
  } catch (err) {
    return { _tag: "ContainerError", message: `Inspect error: ${String(err)}` };
  }
}

// GET /containers/json?filters=... with label filter
export async function listContainers(
  labelFilter: string = "moat-browser=agent-chrome"
): Promise<Array<{ id: string; agentId: string; state: string }> | GatewayError> {
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: [labelFilter] }));
    const res = await dockerFetch(`/containers/json?all=1&filters=${filters}`);

    if (!res.ok) {
      const text = await res.text();
      return { _tag: "ContainerError", message: `List failed (${res.status}): ${text}` };
    }

    const containers = (await res.json()) as Array<{
      Id: string;
      Labels: Record<string, string>;
      State: string;
    }>;

    return containers.map((c) => ({
      id: c.Id,
      agentId: c.Labels["moat-browser.agent-id"] ?? "unknown",
      state: c.State,
    }));
  } catch (err) {
    return { _tag: "ContainerError", message: `List error: ${String(err)}` };
  }
}

// Poll http://{host}:{port}/json/version every 500ms until response or timeout
export async function waitForCDP(
  host: string,
  port: number,
  timeoutMs: number
): Promise<true | GatewayError> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/json/version`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    _tag: "ContainerError",
    message: `CDP not ready at ${host}:${port} after ${timeoutMs}ms`,
  };
}
