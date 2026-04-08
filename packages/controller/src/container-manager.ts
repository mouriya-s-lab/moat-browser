import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ControllerError } from "@moat-browser/types";

const execFile = promisify(execFileCb);

// ─── Result ADT ───

export type Result<T, E> =
  | { readonly _tag: "Ok"; readonly value: T }
  | { readonly _tag: "Err"; readonly error: E };

function Ok<T>(value: T): Result<T, never> {
  return { _tag: "Ok", value };
}

function Err<E>(error: E): Result<never, E> {
  return { _tag: "Err", error };
}

// ─── ContainerInfo ───

export type ContainerInfo = {
  readonly containerId: string;
  readonly ip: string;
  readonly cdpPort: number;
};

// ─── Config ───

export type ContainerManagerConfig = {
  readonly profileSource: string;
  readonly profilesWork: string;
  readonly dockerNetwork: string;
  readonly agentChromeImage: string;
  readonly cdpReadyTimeout: number;
};

// ─── Docker Engine API ───

async function dockerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error — Node.js fetch 支持 Unix socket
    unix: "/var/run/docker.sock",
  });
}

// ─── Container Manager ───

export type ContainerManager = {
  create(sessionId: string, profilePath: string): Promise<Result<ContainerInfo, ControllerError>>;
  destroy(sessionId: string): Promise<Result<void, ControllerError>>;
  inspect(containerId: string): Promise<Result<ContainerInfo, ControllerError>>;
};

export function createContainerManager(config: ContainerManagerConfig): ContainerManager {
  const containers = new Map<string, string>(); // sessionId → containerId

  return { create, destroy, inspect };

  async function create(
    sessionId: string,
    profilePath: string,
  ): Promise<Result<ContainerInfo, ControllerError>> {
    const profileDest = `${config.profilesWork}/agent-${sessionId}`;

    // Step 1: cp -a profile
    try {
      await execFile("cp", ["-a", profilePath, profileDest]);
    } catch (err) {
      return Err({
        _tag: "ProfileCopyFailed",
        message: `cp -a failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 2: chown -R 1000:1000
    try {
      await execFile("chown", ["-R", "1000:1000", profileDest]);
    } catch (err) {
      return Err({
        _tag: "ProfileCopyFailed",
        message: `chown failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 3: POST /containers/create
    let containerId: string;
    try {
      const createRes = await dockerFetch("/containers/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: config.agentChromeImage,
          HostConfig: {
            Binds: [`${profileDest}:/data/profile`],
            NetworkMode: config.dockerNetwork,
            ShmSize: 2147483648,
          },
        }),
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker create failed (${createRes.status}): ${text}` });
      }
      const body = (await createRes.json()) as { Id: string };
      containerId = body.Id;
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker create error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 4: POST /containers/<id>/start
    try {
      const startRes = await dockerFetch(`/containers/${containerId}/start`, {
        method: "POST",
      });
      if (!startRes.ok && startRes.status !== 304) {
        const text = await startRes.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker start failed (${startRes.status}): ${text}` });
      }
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker start error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 5: GET /containers/<id>/json → extract IP
    let ip: string;
    try {
      const inspectRes = await dockerFetch(`/containers/${containerId}/json`);
      if (!inspectRes.ok) {
        const text = await inspectRes.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker inspect failed (${inspectRes.status}): ${text}` });
      }
      const info = (await inspectRes.json()) as {
        NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
      };
      ip = info.NetworkSettings.Networks[config.dockerNetwork].IPAddress;
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker inspect error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 6: Poll CDP ready (http://<ip>:9222/json/version)
    const deadline = Date.now() + config.cdpReadyTimeout;
    let cdpReady = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${ip}:9222/json/version`);
        if (res.ok) {
          cdpReady = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!cdpReady) {
      return Err({ _tag: "CdpUnreachable", containerId });
    }

    // Step 7: Track and return
    containers.set(sessionId, containerId);
    return Ok({ containerId, ip, cdpPort: 9222 } as const);
  }

  async function destroy(sessionId: string): Promise<Result<void, ControllerError>> {
    const containerId = containers.get(sessionId);
    if (!containerId) {
      return Err({ _tag: "ContainerCreateFailed", message: `No container for session ${sessionId}` });
    }

    // Step 1: POST /containers/<id>/stop?t=5
    try {
      const stopRes = await dockerFetch(`/containers/${containerId}/stop?t=5`, {
        method: "POST",
      });
      if (!stopRes.ok && stopRes.status !== 304 && stopRes.status !== 404) {
        const text = await stopRes.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker stop failed (${stopRes.status}): ${text}` });
      }
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker stop error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 2: DELETE /containers/<id>
    try {
      const deleteRes = await dockerFetch(`/containers/${containerId}`, {
        method: "DELETE",
      });
      if (!deleteRes.ok && deleteRes.status !== 404) {
        const text = await deleteRes.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker delete failed (${deleteRes.status}): ${text}` });
      }
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker delete error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 3: rm -rf profile copy
    const profileDest = `${config.profilesWork}/agent-${sessionId}`;
    try {
      await execFile("rm", ["-rf", profileDest]);
    } catch {
      // best-effort cleanup
    }

    containers.delete(sessionId);
    return Ok(undefined);
  }

  async function inspect(containerId: string): Promise<Result<ContainerInfo, ControllerError>> {
    try {
      const res = await dockerFetch(`/containers/${containerId}/json`);
      if (!res.ok) {
        const text = await res.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker inspect failed (${res.status}): ${text}` });
      }
      const info = (await res.json()) as {
        Id: string;
        NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
      };
      const ip = info.NetworkSettings.Networks[config.dockerNetwork].IPAddress;
      return Ok({ containerId: info.Id, ip, cdpPort: 9222 } as const);
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker inspect error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
