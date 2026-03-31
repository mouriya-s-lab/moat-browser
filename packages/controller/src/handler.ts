import {
  type ControllerRequest,
  type ControllerResult,
  type ControllerError,
  ControllerRequestSchema,
  exhaustive,
} from "@moat-browser/types";
import * as dockerOps from "./docker.js";
import * as profileOps from "./profile.js";
import { livePath } from "./config.js";

function isError(v: unknown): v is ControllerError {
  return typeof v === "object" && v !== null && "_tag" in v &&
    typeof (v as { _tag: string })._tag === "string" &&
    [
      "ProfileNotFound", "ProfileNotFrozen", "AgentAlreadyExists",
      "AgentNotFound", "ContainerStartFailed", "ProfileCopyFailed",
      "ChromiumVersionMismatch", "DockerError",
    ].includes((v as { _tag: string })._tag);
}

export async function handleRequest(
  raw: unknown
): Promise<ControllerResult | ControllerError> {
  // Validate input with arktype
  const parsed = ControllerRequestSchema(raw);
  if (parsed instanceof Array) {
    return { _tag: "DockerError", message: `Invalid request: ${parsed[0]}` };
  }

  const req = parsed as ControllerRequest;

  switch (req._tag) {
    case "CreateAgentBrowser":
      return createAgentBrowser(req.agentId, req.profileName);
    case "DestroyAgentBrowser":
      return destroyAgentBrowser(req.agentId);
    case "GetAgentBrowser":
      return getAgentBrowser(req.agentId);
    case "ListAgentBrowsers":
      return listAgentBrowsers();
    case "StartUserChrome":
      return startUserChrome(req.profileName);
    case "StopUserChrome":
      return stopUserChrome();
    case "FreezeProfile":
      return freezeProfile(req.profileName);
    case "ListProfiles":
      return listProfilesHandler();
    case "DeleteProfile":
      return deleteProfile(req.profileName);
    case "HealthCheck":
      return healthCheck(req.agentId);
    default:
      return exhaustive(req);
  }
}

async function createAgentBrowser(
  agentId: string,
  profileName: string
): Promise<ControllerResult | ControllerError> {
  const copyResult = await profileOps.cowCopyProfile(profileName, agentId);
  if (typeof copyResult !== "string") return copyResult;

  const result = await dockerOps.createAgentContainer(agentId, copyResult);
  if (isError(result)) return result;

  return {
    _tag: "AgentBrowserCreated",
    containerId: result.containerId,
    socketPath: result.socketPath,
  };
}

async function destroyAgentBrowser(
  agentId: string
): Promise<ControllerResult | ControllerError> {
  const result = await dockerOps.destroyAgentContainer(agentId);
  if (isError(result)) return result;

  // Clean up live profile
  const liveProfPath = livePath(agentId);
  const { rm } = await import("node:fs/promises");
  await rm(liveProfPath, { recursive: true, force: true });

  return { _tag: "AgentBrowserDestroyed", agentId };
}

async function getAgentBrowser(
  agentId: string
): Promise<ControllerResult | ControllerError> {
  const result = await dockerOps.getAgentInfo(agentId);
  if (isError(result)) return result;
  return { _tag: "AgentBrowserInfo", info: result };
}

async function listAgentBrowsers(): Promise<ControllerResult> {
  const items = await dockerOps.listAgentContainers();
  return { _tag: "AgentBrowserList", items };
}

async function startUserChrome(
  profileName: string
): Promise<ControllerResult | ControllerError> {
  const profilePath = livePath(profileName);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(profilePath, { recursive: true });

  const result = await dockerOps.startUserChromeContainer(profileName, profilePath);
  if (isError(result)) return result;

  return {
    _tag: "UserChromeStarted",
    containerId: result.containerId,
    nekoPort: result.nekoPort,
  };
}

async function stopUserChrome(): Promise<ControllerResult | ControllerError> {
  const result = await dockerOps.stopUserChromeContainer();
  if (isError(result)) return result;
  return { _tag: "UserChromeStopped" };
}

async function freezeProfile(
  profileName: string
): Promise<ControllerResult | ControllerError> {
  const result = await profileOps.freezeProfile(profileName);
  if (isError(result)) return result;
  return {
    _tag: "ProfileFrozen",
    snapshotId: (result as { snapshotId: string }).snapshotId,
    frozenAt: (result as { frozenAt: string }).frozenAt,
  };
}

async function listProfilesHandler(): Promise<ControllerResult> {
  const profiles = await profileOps.listProfiles();
  return { _tag: "ProfileList", profiles };
}

async function deleteProfile(
  profileName: string
): Promise<ControllerResult | ControllerError> {
  const result = await profileOps.deleteProfile(profileName);
  if (isError(result)) return result;
  return { _tag: "ProfileDeleted", profileName };
}

async function healthCheck(
  agentId: string
): Promise<ControllerResult | ControllerError> {
  const info = await dockerOps.getAgentInfo(agentId);
  if (isError(info)) return info;

  return {
    _tag: "HealthStatus",
    status: {
      agentId,
      containerId: info.containerId,
      cdpResponding: info.state === "running",
      socketResponding: info.state === "running",
      uptimeSeconds: 0,
    },
  };
}
