import type { ContainerInfo, ControllerError } from "@moat-browser/types";
import { config } from "./config.js";

const DOCKER_SOCKET = "/var/run/docker.sock";

// Track container metadata
const containerMeta = new Map<string, { createdAt: string; lastActivity: number }>();

function containerName(agentId: string): string {
  return `${config.containerPrefix}${agentId}`;
}

// Docker Engine API via Unix socket (Bun native support)
async function dockerFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: DOCKER_SOCKET,
  });
}

async function dockerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await dockerFetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Docker API ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function dockerVoid(path: string, init?: RequestInit): Promise<void> {
  const res = await dockerFetch(path, init);
  if (!res.ok && res.status !== 304 && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Docker API ${path}: ${res.status} ${text}`);
  }
}

// ---- Container operations ----

export async function createAgentContainer(
  agentId: string,
  profilePath: string
): Promise<{ containerId: string; socketPath: string } | ControllerError> {
  const name = containerName(agentId);

  // Check if already exists
  try {
    const info = await dockerJson<{ State: { Running: boolean } }>(
      `/containers/${name}/json`
    );
    if (info.State.Running) {
      return { _tag: "AgentAlreadyExists", agentId };
    }
    await dockerVoid(`/containers/${name}?force=true`, { method: "DELETE" });
  } catch {
    // Doesn't exist
  }

  try {
    const body = {
      Image: config.agentChromeImage,
      Labels: {
        "moat-browser": "agent-chrome",
        "moat-browser.agent-id": agentId,
      },
      HostConfig: {
        Binds: [`${profilePath}:/data/profile`],
        Memory: config.agentMemoryLimit,
        CpuQuota: config.agentCpuQuota,
        ShmSize: config.agentShmSize,
      },
    };

    const created = await dockerJson<{ Id: string }>(
      `/containers/create?name=${name}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    await dockerVoid(`/containers/${created.Id}/start`, { method: "POST" });

    containerMeta.set(agentId, {
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
    });

    await waitForHealth(created.Id, 30_000);

    return {
      containerId: created.Id,
      socketPath: `/run/agent-browser/main.sock`,
    };
  } catch (err) {
    return { _tag: "ContainerStartFailed", reason: String(err) };
  }
}

export async function destroyAgentContainer(
  agentId: string
): Promise<true | ControllerError> {
  const name = containerName(agentId);

  try {
    await dockerVoid(`/containers/${name}/stop?t=5`, { method: "POST" }).catch(() => {});
    await dockerVoid(`/containers/${name}?force=true`, { method: "DELETE" });
    containerMeta.delete(agentId);
    return true;
  } catch {
    return { _tag: "AgentNotFound", agentId };
  }
}

export async function getAgentInfo(
  agentId: string
): Promise<ContainerInfo | ControllerError> {
  const name = containerName(agentId);

  try {
    const info = await dockerJson<{
      Id: string;
      State: { Running: boolean };
      Created: string;
    }>(`/containers/${name}/json`);

    const meta = containerMeta.get(agentId);

    return {
      containerId: info.Id,
      agentId,
      profileName: agentId,
      state: info.State.Running ? "running" : "stopping",
      createdAt: meta?.createdAt ?? info.Created,
      socketPath: `/run/agent-browser/main.sock`,
    };
  } catch {
    return { _tag: "AgentNotFound", agentId };
  }
}

export async function listAgentContainers(): Promise<ContainerInfo[]> {
  const filters = JSON.stringify({ label: ["moat-browser=agent-chrome"] });
  const containers = await dockerJson<
    Array<{
      Id: string;
      State: string;
      Created: number;
      Labels: Record<string, string>;
    }>
  >(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);

  return containers.map((c) => {
    const agentId = c.Labels["moat-browser.agent-id"] ?? "unknown";
    const meta = containerMeta.get(agentId);
    return {
      containerId: c.Id,
      agentId,
      profileName: agentId,
      state: c.State === "running" ? ("running" as const) : ("stopping" as const),
      createdAt: meta?.createdAt ?? new Date(c.Created * 1000).toISOString(),
    };
  });
}

export async function startUserChromeContainer(
  profileName: string,
  profilePath: string
): Promise<{ containerId: string; nekoPort: number } | ControllerError> {
  const name = config.userChromeContainerName;

  // Stop existing
  try {
    await dockerVoid(`/containers/${name}/stop?t=5`, { method: "POST" }).catch(() => {});
    await dockerVoid(`/containers/${name}?force=true`, { method: "DELETE" });
  } catch {
    // Doesn't exist
  }

  const nekoPort = config.nekoPortRangeStart;

  try {
    const body = {
      Image: config.userChromeImage,
      ExposedPorts: { "8080/tcp": {}, "8081/tcp": {} },
      Env: ["NEKO_SCREEN=1920x1080@30"],
      Labels: {
        "moat-browser": "user-chrome",
        "moat-browser.profile": profileName,
      },
      HostConfig: {
        Binds: [`${profilePath}:/data/profile`],
        PortBindings: {
          "8080/tcp": [{ HostPort: String(nekoPort) }],
          "8081/tcp": [{ HostPort: String(nekoPort + 1) }],
        },
        ShmSize: 2 * 1024 * 1024 * 1024,
      },
    };

    const created = await dockerJson<{ Id: string }>(
      `/containers/create?name=${name}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    await dockerVoid(`/containers/${created.Id}/start`, { method: "POST" });
    await waitForHealth(created.Id, 30_000);

    return { containerId: created.Id, nekoPort };
  } catch (err) {
    return { _tag: "ContainerStartFailed", reason: String(err) };
  }
}

export async function stopUserChromeContainer(): Promise<true | ControllerError> {
  const name = config.userChromeContainerName;

  try {
    await dockerVoid(`/containers/${name}/stop?t=10`, { method: "POST" }).catch(() => {});
    await dockerVoid(`/containers/${name}?force=true`, { method: "DELETE" });
    return true;
  } catch {
    return { _tag: "DockerError", message: "user-chrome container not found" };
  }
}

export function getTimedOutAgents(timeoutMs: number): string[] {
  const now = Date.now();
  const timedOut: string[] = [];
  for (const [agentId, meta] of containerMeta) {
    if (now - meta.lastActivity > timeoutMs) {
      timedOut.push(agentId);
    }
  }
  return timedOut;
}

export function touchActivity(agentId: string): void {
  const meta = containerMeta.get(agentId);
  if (meta) {
    meta.lastActivity = Date.now();
  }
}

async function waitForHealth(containerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await dockerJson<{
        State: { Running: boolean; Health?: { Status: string } };
      }>(`/containers/${containerId}/json`);
      if (info.State.Health?.Status === "healthy" || info.State.Running) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
