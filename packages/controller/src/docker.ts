import Docker from "dockerode";
import type { ContainerInfo, ControllerError } from "@moat-browser/types";
import { config } from "./config.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Track container metadata not stored in Docker labels
const containerMeta = new Map<string, { createdAt: string; lastActivity: number }>();

function containerName(agentId: string): string {
  return `${config.containerPrefix}${agentId}`;
}

export async function createAgentContainer(
  agentId: string,
  profilePath: string
): Promise<{ containerId: string; socketPath: string } | ControllerError> {
  const name = containerName(agentId);

  // Check if already exists
  try {
    const existing = docker.getContainer(name);
    const info = await existing.inspect();
    if (info.State.Running) {
      return { _tag: "AgentAlreadyExists", agentId };
    }
    // Exists but not running — remove and recreate
    await existing.remove({ force: true });
  } catch {
    // Doesn't exist, continue
  }

  try {
    const container = await docker.createContainer({
      name,
      Image: config.agentChromeImage,
      HostConfig: {
        Binds: [`${profilePath}:/data/profile`],
        Memory: config.agentMemoryLimit,
        CpuQuota: config.agentCpuQuota,
        ShmSize: config.agentShmSize,
      },
      Labels: {
        "moat-browser": "agent-chrome",
        "moat-browser.agent-id": agentId,
      },
    });

    await container.start();
    const containerId = container.id;
    const socketPath = `/run/agent-browser/main.sock`;

    containerMeta.set(agentId, {
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
    });

    // Wait for healthy
    await waitForHealth(containerId, 30_000);

    return { containerId, socketPath };
  } catch (err) {
    return { _tag: "ContainerStartFailed", reason: String(err) };
  }
}

export async function destroyAgentContainer(
  agentId: string
): Promise<true | ControllerError> {
  const name = containerName(agentId);

  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
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
    const container = docker.getContainer(name);
    const info = await container.inspect();
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
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ["moat-browser=agent-chrome"] },
  });

  return containers.map((c) => {
    const agentId = c.Labels["moat-browser.agent-id"] ?? "unknown";
    const meta = containerMeta.get(agentId);
    return {
      containerId: c.Id,
      agentId,
      profileName: agentId,
      state: c.State === "running" ? "running" as const : "stopping" as const,
      createdAt: meta?.createdAt ?? new Date(c.Created * 1000).toISOString(),
    };
  });
}

export async function startUserChromeContainer(
  profileName: string,
  profilePath: string
): Promise<{ containerId: string; nekoPort: number } | ControllerError> {
  const name = config.userChromeContainerName;

  // Stop existing if any
  try {
    const existing = docker.getContainer(name);
    await existing.stop({ t: 5 }).catch(() => {});
    await existing.remove({ force: true });
  } catch {
    // Doesn't exist
  }

  const nekoPort = config.nekoPortRangeStart;

  try {
    const container = await docker.createContainer({
      name,
      Image: config.userChromeImage,
      ExposedPorts: { "8080/tcp": {}, "8081/tcp": {} },
      HostConfig: {
        Binds: [`${profilePath}:/data/profile`],
        PortBindings: {
          "8080/tcp": [{ HostPort: String(nekoPort) }],
          "8081/tcp": [{ HostPort: String(nekoPort + 1) }],
        },
        ShmSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
      Env: [
        `NEKO_SCREEN=1920x1080@30`,
      ],
      Labels: {
        "moat-browser": "user-chrome",
        "moat-browser.profile": profileName,
      },
    });

    await container.start();
    await waitForHealth(container.id, 30_000);

    return { containerId: container.id, nekoPort };
  } catch (err) {
    return { _tag: "ContainerStartFailed", reason: String(err) };
  }
}

export async function stopUserChromeContainer(): Promise<true | ControllerError> {
  const name = config.userChromeContainerName;

  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 10 }).catch(() => {});
    await container.remove({ force: true });
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
  const container = docker.getContainer(containerId);

  while (Date.now() < deadline) {
    try {
      const info = await container.inspect();
      if (info.State.Health?.Status === "healthy" || info.State.Running) {
        return;
      }
    } catch {
      // Container might not be ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
