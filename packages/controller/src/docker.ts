import type { ContainerError } from "@moat-browser/types";
import type { Config } from "./config";

type DockerResult<T> = { readonly _tag: "Ok"; readonly value: T } | ContainerError;

interface ContainerInfo {
  readonly id: string;
  readonly ip: string;
  readonly name: string;
}

async function dockerFetch(
  socketPath: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `http://localhost${path}`;
  return fetch(url, {
    ...options,
    // @ts-ignore Bun supports unix socket in fetch
    unix: socketPath,
  });
}

export async function createAgentContainer(
  sessionId: string,
  config: Config
): Promise<DockerResult<ContainerInfo>> {
  const profileDest = `${config.profileBasePath}/agent-${sessionId}`;
  const containerName = `agent-chrome-${sessionId}`;

  try {
    // 1. Copy profile
    const cpResult = Bun.spawnSync(["cp", "-a", config.profileSourcePath, profileDest]);
    if (cpResult.exitCode !== 0) {
      return { _tag: "ContainerError", message: `profile copy failed: ${cpResult.stderr.toString()}` };
    }

    // chown to uid 1000 (chromium user inside container)
    const chownResult = Bun.spawnSync(["chown", "-R", "1000:1000", profileDest]);
    if (chownResult.exitCode !== 0) {
      return { _tag: "ContainerError", message: `chown failed: ${chownResult.stderr.toString()}` };
    }

    // 2. Create container
    const createBody = {
      Image: config.agentChromeImage,
      name: containerName,
      HostConfig: {
        Binds: [`${profileDest}:/data/profile`],
      },
    };

    const createRes = await dockerFetch(config.dockerSocket, `/containers/create?name=${containerName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return { _tag: "ContainerError", message: `container create failed: ${errText}` };
    }

    const createData = (await createRes.json()) as { Id: string };
    const containerId = createData.Id;

    // 3. Start container
    const startRes = await dockerFetch(config.dockerSocket, `/containers/${containerId}/start`, {
      method: "POST",
    });

    if (!startRes.ok && startRes.status !== 304) {
      const errText = await startRes.text();
      return { _tag: "ContainerError", message: `container start failed: ${errText}` };
    }

    // 4. Get container IP
    const inspectRes = await dockerFetch(config.dockerSocket, `/containers/${containerId}/json`);
    if (!inspectRes.ok) {
      return { _tag: "ContainerError", message: "container inspect failed" };
    }

    const inspectData = (await inspectRes.json()) as {
      NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
    };

    const networks = inspectData.NetworkSettings.Networks;
    const firstNetwork = Object.values(networks)[0];
    const ip = firstNetwork?.IPAddress ?? "";

    if (ip === "") {
      return { _tag: "ContainerError", message: "container has no IP address" };
    }

    return { _tag: "Ok", value: { id: containerId, ip, name: containerName } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { _tag: "ContainerError", message: `docker error: ${message}` };
  }
}

export async function destroyAgentContainer(
  sessionId: string,
  config: Config
): Promise<DockerResult<void>> {
  const containerName = `agent-chrome-${sessionId}`;
  const profileDest = `${config.profileBasePath}/agent-${sessionId}`;

  try {
    // Stop container (ignore errors if already stopped)
    await dockerFetch(config.dockerSocket, `/containers/${containerName}/stop`, {
      method: "POST",
    });

    // Remove container
    const rmRes = await dockerFetch(config.dockerSocket, `/containers/${containerName}?force=true`, {
      method: "DELETE",
    });

    if (!rmRes.ok && rmRes.status !== 404) {
      const errText = await rmRes.text();
      return { _tag: "ContainerError", message: `container remove failed: ${errText}` };
    }

    // Clean up profile copy
    Bun.spawnSync(["rm", "-rf", profileDest]);

    return { _tag: "Ok", value: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { _tag: "ContainerError", message: `docker cleanup error: ${message}` };
  }
}

export async function waitForCDP(ip: string, timeoutMs: number = 15000): Promise<DockerResult<void>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${ip}:9222/json/version`);
      if (res.ok) {
        return { _tag: "Ok", value: undefined };
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(500);
  }
  return { _tag: "ContainerError", message: `CDP not ready after ${timeoutMs}ms` };
}
