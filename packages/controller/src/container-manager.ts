import { execFile as execFileCb } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
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

export type DockerFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ContainerManagerConfig = {
  readonly profileSource: string;
  readonly profilesWork: string;
  readonly profilesHostPath: string;
  readonly dockerNetwork: string;
  readonly agentChromeImage: string;
  readonly cdpReadyTimeout: number;
  readonly owner: string;
  readonly dockerFetch?: DockerFetch;
};

// ─── Labels ───

export const LABEL_ROLE = "moat-browser.role";
export const LABEL_ROLE_AGENT_CHROME = "agent-chrome";
export const LABEL_SESSION_ID = "moat-browser.session-id";
export const LABEL_OWNER = "moat-browser.owner";

function ownerPathToken(owner: string): string {
  return Buffer.from(owner, "utf8").toString("base64url");
}

function profileDestination(profilesWork: string, owner: string, sessionId: string): string {
  return `${profilesWork}/agent-${ownerPathToken(owner)}-${sessionId}`;
}

// ─── Controller owner resolution ───

export type OwnerResolutionError = {
  readonly _tag: "OwnerUnavailable";
  readonly message: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function composeProjectFromInspect(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const config = value.Config;
  if (!isRecord(config)) return undefined;
  const labels = config.Labels;
  if (!isRecord(labels)) return undefined;
  const project = labels["com.docker.compose.project"];
  return typeof project === "string" && project.length > 0 ? project : undefined;
}

/**
 * Resolve the stable logical-controller owner once at startup.
 *
 * Explicit CONTROLLER_OWNER is useful for deployments that cannot expose a
 * Compose label. Otherwise the controller inspects its own container and
 * inherits the stable Compose project label. There is deliberately no
 * collision-prone fallback.
 */
export async function resolveControllerOwner(
  explicitOwner: string | undefined,
  dockerFetch: DockerFetch = defaultDockerFetch,
): Promise<Result<string, OwnerResolutionError>> {
  const configured = explicitOwner?.trim();
  if (configured) return Ok(configured);

  let hostname: string;
  try {
    hostname = (await readFile("/etc/hostname", "utf8")).trim();
  } catch (error) {
    return Err({
      _tag: "OwnerUnavailable",
      message: `CONTROLLER_OWNER is unset and /etc/hostname is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  if (!hostname) {
    return Err({
      _tag: "OwnerUnavailable",
      message: "CONTROLLER_OWNER is unset and /etc/hostname is empty",
    });
  }

  try {
    const response = await dockerFetch(`/containers/${encodeURIComponent(hostname)}/json`);
    if (!response.ok) {
      const text = await response.text();
      return Err({
        _tag: "OwnerUnavailable",
        message: `CONTROLLER_OWNER is unset and self-inspect failed (${response.status}): ${text}`,
      });
    }
    const project = composeProjectFromInspect(await response.json());
    if (!project) {
      return Err({
        _tag: "OwnerUnavailable",
        message: "CONTROLLER_OWNER is unset and self container has no com.docker.compose.project label",
      });
    }
    return Ok(project);
  } catch (error) {
    return Err({
      _tag: "OwnerUnavailable",
      message: `CONTROLLER_OWNER is unset and self-inspect failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

export function buildCreateBody(
  sessionId: string,
  cfg: Pick<ContainerManagerConfig, "agentChromeImage" | "profilesHostPath" | "dockerNetwork" | "owner">,
): Record<string, unknown> {
  return {
    Image: cfg.agentChromeImage,
    Labels: {
      [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME,
      [LABEL_SESSION_ID]: sessionId,
      [LABEL_OWNER]: cfg.owner,
    },
    HostConfig: {
      Binds: [`${cfg.profilesHostPath}/agent-${ownerPathToken(cfg.owner)}-${sessionId}:/data/profile`],
      NetworkMode: cfg.dockerNetwork,
      ShmSize: 2147483648,
    },
  };
}

// ─── Docker Engine API ───

const defaultDockerFetch: DockerFetch = async (path, init) => {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: "/var/run/docker.sock",
        path,
        method: (init?.method as string) ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 500;
          const body = Buffer.concat(chunks).toString();
          // 204/304 responses must not have a body per HTTP spec
          const responseBody = status === 204 || status === 304 ? null : body;
          resolve(new Response(responseBody, { status }));
        });
      },
    );
    req.on("error", reject);
    if (init?.body) {
      req.write(String(init.body));
    }
    req.end();
  });
};

// ─── Container Manager ───

export type ContainerManager = {
  create(sessionId: string, profilePath: string): Promise<Result<ContainerInfo, ControllerError>>;
  destroy(sessionId: string): Promise<Result<void, ControllerError>>;
  inspect(containerId: string): Promise<Result<ContainerInfo, ControllerError>>;
  reap(): Promise<Result<{ readonly reaped: number }, ControllerError>>;
};

export function createContainerManager(config: ContainerManagerConfig): ContainerManager {
  const dockerFetch = config.dockerFetch ?? defaultDockerFetch;
  const containers = new Map<string, string>(); // sessionId → containerId

  return { create, destroy, inspect, reap };

  async function create(
    sessionId: string,
    profilePath: string,
  ): Promise<Result<ContainerInfo, ControllerError>> {
    const profileDest = profileDestination(config.profilesWork, config.owner, sessionId);

    // Step 1: cp -a profile
    try {
      await execFile("cp", ["-a", profilePath, profileDest]);
    } catch (err) {
      return Err({
        _tag: "ProfileCopyFailed",
        message: `cp -a failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 2: Strip Default/ down to auth-relevant files only.
    // Debian Chromium (user-chrome) profile is incompatible with Chrome for Testing —
    // keeping Preferences, GPUCache, Code Cache, etc. causes SIGTRAP crash.
    // Whitelist: Cookies, Local Storage, Session Storage, IndexedDB (auth state).
    const defaultDir = `${profileDest}/Default`;
    try {
      const { stdout } = await execFile("ls", [defaultDir]);
      const keep = new Set([
        "Cookies", "Cookies-journal",
        "Local Storage", "Session Storage", "IndexedDB",
      ]);
      const entries = stdout.split("\n").filter(Boolean);
      for (const entry of entries) {
        if (!keep.has(entry)) {
          await execFile("rm", ["-rf", `${defaultDir}/${entry}`]);
        }
      }
    } catch {
      // best-effort — Default may not exist
    }
    try {
      await execFile("find", [profileDest, "-maxdepth", "1", "-name", "Singleton*", "-delete"]);
    } catch {
      // best-effort
    }

    // Step 3: chown -R 1000:1000
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
        body: JSON.stringify(buildCreateBody(sessionId, config)),
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
    let containerId = containers.get(sessionId);
    if (!containerId) {
      // Fallback: owner-scoped label reverse-lookup covers the
      // create-before-map and cross-restart windows without crossing owners.
      const found = await findContainerIdBySession(sessionId);
      if (found._tag === "Err") return found;
      if (found.value === undefined) {
        return Err({ _tag: "SessionNotFound", sessionId });
      }
      containerId = found.value;
    }

    const stopDelete = await stopAndDelete(containerId);
    if (stopDelete._tag === "Err") return stopDelete;

    try {
      await execFile("rm", ["-rf", profileDestination(config.profilesWork, config.owner, sessionId)]);
    } catch {
      // best-effort — Docker is the authoritative resource terminal state
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

  async function reap(): Promise<Result<{ readonly reaped: number }, ControllerError>> {
    const found = await listAgentChromeContainers();
    if (found._tag === "Err") return found;

    let reaped = 0;
    for (const c of found.value) {
      const stopDelete = await stopAndDelete(c.id);
      if (stopDelete._tag === "Err") {
        console.warn(
          `[reap-failed] owner=${config.owner} container=${c.id} session=${c.sessionId ?? "unknown"} ${
            stopDelete.error._tag
          }: ${"message" in stopDelete.error ? stopDelete.error.message : ""}`,
        );
        continue;
      }
      if (c.sessionId) {
        try {
          await execFile(
            "rm",
            ["-rf", profileDestination(config.profilesWork, config.owner, c.sessionId)],
          );
        } catch {
          // best-effort — Docker is the authoritative resource terminal state
        }
        containers.delete(c.sessionId);
      }
      reaped++;
    }
    return Ok({ reaped });
  }
  async function findContainerIdBySession(sessionId: string): Promise<Result<string | undefined, ControllerError>> {
    const filters = JSON.stringify({
      label: [
        `${LABEL_ROLE}=${LABEL_ROLE_AGENT_CHROME}`,
        `${LABEL_OWNER}=${config.owner}`,
        `${LABEL_SESSION_ID}=${sessionId}`,
      ],
    });
    try {
      const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
      if (!res.ok) {
        const text = await res.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker list failed (${res.status}): ${text}` });
      }
      const body = (await res.json()) as ReadonlyArray<{ readonly Id: string }>;
      if (body.length > 1) {
        return Err({
          _tag: "ContainerCreateFailed",
          message: `Multiple containers for owner ${config.owner} session ${sessionId}`,
        });
      }
      return Ok(body[0]?.Id);
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker list error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function listAgentChromeContainers(): Promise<
    Result<ReadonlyArray<{ readonly id: string; readonly sessionId: string | undefined }>, ControllerError>
  > {
    const filters = JSON.stringify({
      label: [
        `${LABEL_ROLE}=${LABEL_ROLE_AGENT_CHROME}`,
        `${LABEL_OWNER}=${config.owner}`,
      ],
    });
    try {
      const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
      if (!res.ok) {
        const text = await res.text();
        return Err({ _tag: "ContainerCreateFailed", message: `Docker list failed (${res.status}): ${text}` });
      }
      const body = (await res.json()) as ReadonlyArray<{
        readonly Id: string;
        readonly Labels?: Readonly<Record<string, string>>;
      }>;
      return Ok(body.map((c) => ({ id: c.Id, sessionId: c.Labels?.[LABEL_SESSION_ID] })));
    } catch (err) {
      return Err({
        _tag: "ContainerCreateFailed",
        message: `Docker list error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function stopAndDelete(containerId: string): Promise<Result<void, ControllerError>> {
    try {
      const stopRes = await dockerFetch(`/containers/${containerId}/stop?t=5`, { method: "POST" });
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
    try {
      const deleteRes = await dockerFetch(`/containers/${containerId}`, { method: "DELETE" });
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
    return Ok(undefined);
  }
}
