/**
 * docker.ts — Container Manager
 *
 * Manages agent-chrome container lifecycle via the Docker Engine API Unix socket.
 * Does NOT use dockerode — uses fetch + Unix socket directly.
 */

import { $ } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DOCKER_SOCKET = process.env["DOCKER_SOCKET"] ?? "/var/run/docker.sock";
const DOCKER_API = "http://localhost/v1.41";
const AGENT_CHROME_IMAGE =
  process.env["AGENT_CHROME_IMAGE"] ?? "moat-browser/agent-chrome:latest";
const DOCKER_NETWORK = process.env["DOCKER_NETWORK"] ?? "moat-browser";
const PROFILE_BASE_DIR =
  process.env["PROFILE_BASE_DIR"] ?? "/data/profiles/base";
const PROFILE_AGENTS_DIR =
  process.env["PROFILE_AGENTS_DIR"] ?? "/data/profiles/agents";
const CDP_PORT = parseInt(process.env["CDP_PORT"] ?? "9222", 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerInfo {
  readonly containerId: string;
  readonly containerIp: string;
  readonly profilePath: string;
}

export interface ContainerSummary {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Call the Docker Engine API via Unix socket. */
async function dockerFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${DOCKER_API}${path}`;
  return fetch(url, {
    ...init,
    unix: DOCKER_SOCKET,
  });
}

async function dockerJSON<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await dockerFetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Docker API ${init?.method ?? "GET"} ${path} → ${res.status}: ${text}`
    );
  }
  return res.json() as Promise<T>;
}

/** POST with JSON body, returning parsed JSON. */
async function dockerPost<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "POST" };
  return dockerJSON<T>(path, init);
}

/** DELETE, ignoring response body. */
async function dockerDelete(path: string): Promise<void> {
  const res = await dockerFetch(path, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Docker API DELETE ${path} → ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Raw Docker response shapes (minimal — only fields we use)
// ---------------------------------------------------------------------------

interface DockerContainerCreated {
  Id: string;
}

interface DockerContainerInspect {
  Id: string;
  NetworkSettings: {
    Networks: Record<
      string,
      {
        IPAddress: string;
      }
    >;
  };
}

interface DockerContainerListItem {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an agent-chrome container for the given agentId.
 *
 * Steps:
 *  1. cp -a the base profile to a per-agent copy
 *  2. Create the container with the profile copy mounted
 *  3. Start the container
 *  4. Inspect to get the container IP
 */
export async function createAgentChrome(
  agentId: string
): Promise<ContainerInfo> {
  const profilePath = `${PROFILE_AGENTS_DIR}/${agentId}`;

  // 1. Copy base profile for this agent
  await $`cp -a ${PROFILE_BASE_DIR} ${profilePath}`.quiet();

  let containerId: string;
  try {
    // 2. Create the container
    const created = await dockerPost<DockerContainerCreated>(
      `/containers/create?name=moat-agent-${agentId}`,
      {
        Image: AGENT_CHROME_IMAGE,
        Labels: {
          "moat-browser.managed": "true",
          "moat-browser.agentId": agentId,
        },
        HostConfig: {
          NetworkMode: DOCKER_NETWORK,
          Binds: [`${profilePath}:/data/profile:rw`],
          ShmSize: 256 * 1024 * 1024, // 256 MB — Chromium needs this
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [DOCKER_NETWORK]: {},
          },
        },
      }
    );
    containerId = created.Id;

    // 3. Start
    const startRes = await dockerFetch(`/containers/${containerId}/start`, {
      method: "POST",
    });
    if (!startRes.ok && startRes.status !== 304) {
      const text = await startRes.text();
      throw new Error(
        `Failed to start container ${containerId}: ${startRes.status} ${text}`
      );
    }
  } catch (err) {
    // Clean up the profile copy if container creation/start failed
    await $`rm -rf ${profilePath}`.quiet().nothrow();
    throw err;
  }

  // 4. Inspect to get IP
  const inspect = await inspectContainer(containerId);
  const containerIp = inspect.NetworkSettings.Networks[DOCKER_NETWORK]?.IPAddress;
  if (!containerIp) {
    await $`rm -rf ${profilePath}`.quiet().nothrow();
    await dockerDelete(`/containers/${containerId}?force=true`).catch(() => {});
    throw new Error(
      `Container ${containerId} has no IP on network ${DOCKER_NETWORK}`
    );
  }

  return { containerId, containerIp, profilePath };
}

/**
 * Stop and remove an agent-chrome container, then delete the profile copy.
 */
export async function destroyAgentChrome(
  containerId: string,
  profilePath: string
): Promise<void> {
  // Stop with a 5-second grace period
  const stopRes = await dockerFetch(
    `/containers/${containerId}/stop?t=5`,
    { method: "POST" }
  );
  // 304 = already stopped, 404 = already gone — both are fine
  if (!stopRes.ok && stopRes.status !== 304 && stopRes.status !== 404) {
    const text = await stopRes.text();
    throw new Error(
      `Failed to stop container ${containerId}: ${stopRes.status} ${text}`
    );
  }

  // Remove the container
  await dockerDelete(`/containers/${containerId}?force=true`).catch(
    (err: unknown) => {
      // 404 means already gone — ignore
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) throw err;
    }
  );

  // Delete the profile copy
  await $`rm -rf ${profilePath}`.quiet().nothrow();
}

/**
 * Inspect a container and return the raw Docker inspect response.
 */
export async function inspectContainer(
  containerId: string
): Promise<DockerContainerInspect> {
  return dockerJSON<DockerContainerInspect>(`/containers/${containerId}/json`);
}

/**
 * Get the IP address of a container on the moat-browser network.
 */
export async function getContainerIp(containerId: string): Promise<string> {
  const inspect = await inspectContainer(containerId);
  const ip = inspect.NetworkSettings.Networks[DOCKER_NETWORK]?.IPAddress;
  if (!ip) {
    throw new Error(
      `Container ${containerId} has no IP on network ${DOCKER_NETWORK}`
    );
  }
  return ip;
}

/**
 * List all containers managed by moat-browser.
 */
export async function listContainers(): Promise<readonly ContainerSummary[]> {
  const filters = JSON.stringify({ label: ["moat-browser.managed=true"] });
  const items = await dockerJSON<readonly DockerContainerListItem[]>(
    `/containers/json?all=true&filters=${encodeURIComponent(filters)}`
  );
  return items.map((item) => ({
    id: item.Id,
    names: item.Names,
    state: item.State,
    status: item.Status,
    labels: item.Labels,
  }));
}

/**
 * Wait for the CDP WebSocket endpoint to become available.
 *
 * Polls GET http://{host}:{port}/json/version every 250 ms until the
 * endpoint responds with 200, or the timeout is exceeded.
 */
export async function waitForCDP(
  host: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/json/version`;
  const intervalMs = 250;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(intervalMs) });
      if (res.ok) return;
    } catch {
      // connection refused or timeout — keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining))
    );
  }

  throw new Error(
    `CDP on ${host}:${port} did not become ready within ${timeoutMs}ms`
  );
}
