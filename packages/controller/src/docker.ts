import * as http from "node:http";
import type { Config } from "./config";
import { copyProfile, cleanupProfile } from "./profile";

interface DockerResponse {
  readonly status: number;
  readonly body: unknown;
}

function dockerRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown
): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: `/v1.43${path}`,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 500, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export interface ContainerInfo {
  readonly id: string;
  readonly ip: string;
}

type ContainerError = { readonly _tag: "ContainerError"; readonly message: string };

export async function createAgentContainer(
  config: Config,
  sessionId: string
): Promise<ContainerInfo | ContainerError> {
  const profileDir = `${config.profilesDir}/agent-${sessionId}`;

  const profileResult = await copyProfile(config, sessionId);
  if (profileResult !== undefined) {
    return {
      _tag: "ContainerError",
      message: profileResult.message,
    };
  }

  const createBody: Record<string, unknown> = {
    Image: config.agentChromeImage,
    HostConfig: {
      Binds: [`${profileDir}:/data/profile`],
    },
  };

  if (config.dockerNetwork) {
    createBody.NetworkingConfig = {
      EndpointsConfig: {
        [config.dockerNetwork]: {},
      },
    };
  }

  const createRes = await dockerRequest(config.dockerSocket, "POST", "/containers/create", createBody);

  if (createRes.status !== 201) {
    return {
      _tag: "ContainerError",
      message: `Failed to create container: ${JSON.stringify(createRes.body)}`,
    };
  }

  const containerId = (createRes.body as { Id: string }).Id;

  const startRes = await dockerRequest(
    config.dockerSocket,
    "POST",
    `/containers/${containerId}/start`
  );

  if (startRes.status !== 204 && startRes.status !== 304) {
    return {
      _tag: "ContainerError",
      message: `Failed to start container: ${JSON.stringify(startRes.body)}`,
    };
  }

  const inspectRes = await dockerRequest(
    config.dockerSocket,
    "GET",
    `/containers/${containerId}/json`
  );

  if (inspectRes.status !== 200) {
    return {
      _tag: "ContainerError",
      message: `Failed to inspect container: ${JSON.stringify(inspectRes.body)}`,
    };
  }

  const inspectBody = inspectRes.body as {
    NetworkSettings: {
      IPAddress: string;
      Networks: Record<string, { IPAddress: string }>;
    };
  };

  const ip = config.dockerNetwork
    ? inspectBody.NetworkSettings.Networks[config.dockerNetwork]?.IPAddress ??
      inspectBody.NetworkSettings.IPAddress
    : inspectBody.NetworkSettings.IPAddress;

  return { id: containerId, ip };
}

export async function destroyAgentContainer(
  config: Config,
  containerId: string,
  sessionId: string
): Promise<void | ContainerError> {
  await dockerRequest(
    config.dockerSocket,
    "POST",
    `/containers/${containerId}/stop?t=5`
  );

  const removeRes = await dockerRequest(
    config.dockerSocket,
    "DELETE",
    `/containers/${containerId}?force=true`
  );

  if (removeRes.status !== 204) {
    return {
      _tag: "ContainerError",
      message: `Failed to remove container: ${JSON.stringify(removeRes.body)}`,
    };
  }

  await cleanupProfile(config, sessionId);
}

export async function waitForCdp(
  ip: string,
  timeoutMs: number = 30000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${ip}:9222/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
