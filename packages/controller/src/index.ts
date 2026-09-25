import { WebSocketServer } from "ws";
import {
  createContainerManager,
  parseProfileRegistry,
  resolveControllerOwner,
  type ProfileRegistry,
} from "./container-manager.js";
import { loadExpectedBrowserVersion } from "./browser-anchor.js";
import { createSessionAdmission } from "./session-admission.js";
import { createSessionRegistry } from "./session-registry.js";
import { createRefStore } from "./ref-store.js";
import { createWsHandler } from "./ws-server.js";

// ─── ControllerConfig ───
export type ControllerConfig = {
  readonly port: number;
  readonly profileSource: string;
  readonly profileRegistry: ProfileRegistry;
  readonly profileStoreRoot: string;
  readonly profilesWork: string;
  readonly profilesHostPath: string;
  readonly dockerNetwork: string;
  readonly agentChromeImage: string;
  readonly sessionIdleTimeout: number;
  readonly cdpReadyTimeout: number;
  readonly commandTimeout: number;
  readonly controllerOwner: string;
  readonly sessionQuotaTotal: number;
  readonly sessionQuota: number;
  readonly sessionOwnerQuotas: Readonly<Record<string, number>> | undefined;
  readonly admissionStatePath: string;
};

function parseQuota(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) ? value : -1;
}

function parseOwnerQuotas(raw: string | undefined): Readonly<Record<string, number>> | undefined {
  if (!raw?.trim()) return undefined;
  const quotas: Record<string, number> = {};
  for (const item of raw.split(",")) {
    const [owner, quota] = item.split("=", 2).map((part) => part.trim());
    if (!owner || quota === undefined) {
      quotas["__invalid__"] = 6;
      continue;
    }
    quotas[owner] = parseQuota(quota, 6);
  }
  return quotas;
}

async function loadConfig(): Promise<ControllerConfig> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const profileSource = process.env.PROFILE_SOURCE ?? "/data/profile";
  const profilesWork = process.env.PROFILES_WORK ?? "/data/profiles";
  const profileStoreRoot = process.env.PROFILE_STORE ?? profilesWork;
  const dockerNetwork = process.env.DOCKER_NETWORK ?? "moat";
  const profileRegistryResult = parseProfileRegistry(process.env.PROFILE_REGISTRY);
  if (profileRegistryResult._tag === "Err") {
    console.error(`[profile-config] ${profileRegistryResult.error.message}`);
    process.exit(78);
  }
  const ownerResult = await resolveControllerOwner(process.env.CONTROLLER_OWNER);
  if (ownerResult._tag === "Err") {
    console.error(`[controller-owner] ${ownerResult.error.message}`);
    process.exit(78);
  }

  const sessionQuotaTotal = parseQuota(process.env.SESSION_TOTAL_QUOTA, 5);
  const sessionQuota = parseQuota(process.env.SESSION_QUOTA, sessionQuotaTotal);
  const sessionOwnerQuotas = parseOwnerQuotas(process.env.SESSION_OWNER_QUOTAS);

  return {
    port,
    profileSource,
    profileRegistry: profileRegistryResult.value,
    profileStoreRoot,
    profilesWork,
    profilesHostPath: process.env.PROFILES_HOST_PATH ?? profilesWork,
    dockerNetwork,
    agentChromeImage: process.env.AGENT_CHROME_IMAGE ?? "agent-chrome:latest",
    sessionIdleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT ?? "600000", 10),
    cdpReadyTimeout: parseInt(process.env.CDP_READY_TIMEOUT ?? "30000", 10),
    commandTimeout: parseInt(process.env.COMMAND_TIMEOUT ?? "25000", 10),
    controllerOwner: ownerResult.value,
    sessionQuotaTotal,
    sessionQuota,
    sessionOwnerQuotas,
    admissionStatePath: process.env.ADMISSION_STATE_PATH ?? `${profilesWork}/.moat-admission`,
  };
}

// ─── Entry ───

const config = await loadConfig();

const expectedBrowserVersion = await loadExpectedBrowserVersion();
if (expectedBrowserVersion._tag === "Err") {
  console.error(`[browser-anchor] ${expectedBrowserVersion.error}`);
  process.exit(78);
}
console.log(`[browser-anchor] expected agent-chrome version ${expectedBrowserVersion.value}`);

const containerManager = createContainerManager({
  profileSource: config.profileSource,
  profileRegistry: config.profileRegistry,
  profileStoreRoot: config.profileStoreRoot,
  profilesWork: config.profilesWork,
  profilesHostPath: config.profilesHostPath,
  dockerNetwork: config.dockerNetwork,
  agentChromeImage: config.agentChromeImage,
  cdpReadyTimeout: config.cdpReadyTimeout,
  expectedBrowserVersion: expectedBrowserVersion.value,
  owner: config.controllerOwner,
});

// A capacity retry must not reclaim a reservation while profile copy, Docker
// startup, and CDP readiness are still in flight; two configured CDP budgets
// provide a derived grace period without hard-coding the timeout.
const admission = createSessionAdmission({
  owner: config.controllerOwner,
  ownerQuota: config.sessionQuota,
  totalQuota: config.sessionQuotaTotal,
  pendingReservationGraceMs: config.cdpReadyTimeout * 2,
  ownerQuotas: config.sessionOwnerQuotas,
  statePath: config.admissionStatePath,
  listExternalAllocations: containerManager.listAllocations,
});

const admissionConfig = admission.validate();
if (admissionConfig._tag === "Err") {
  console.error(
    `[admission-config] ${"message" in admissionConfig.error ? admissionConfig.error.message : admissionConfig.error._tag}`,
  );
  process.exit(78);
}

const refStore = createRefStore();

const registry = createSessionRegistry(
  {
    sessionIdleTimeout: config.sessionIdleTimeout,
  },
  (sessionId, reason) => {
    handler.onSessionExpired(sessionId, reason);
  },
);

const handler = createWsHandler({
  registry,
  admission,
  containerManager,
  refStore,
  config,
});

// Startup reap is owner-scoped: this controller can only reclaim its own
// agent-chrome containers. A missing owner is a startup error, never a reason
// to fall back to a global role-label sweep.
const reapResult = await containerManager.reap();
if (reapResult._tag === "Ok") {
  console.log(`[startup-reap] owner=${config.controllerOwner} reaped=${reapResult.value.reaped}`);
} else {
  console.warn(
    `[startup-reap-failed] owner=${config.controllerOwner} ${reapResult.error._tag}: ${
      "message" in reapResult.error ? reapResult.error.message : ""
    }`,
  );
}

if (reapResult._tag === "Ok") {
  const reconciled = await admission.reconcile();
  if (reconciled._tag === "Ok") {
    console.log(`[admission-reconcile] owner=${config.controllerOwner} removed=${reconciled.value.removed}`);
  } else {
    console.warn(
      `[admission-reconcile-failed] owner=${config.controllerOwner} ${reconciled.error._tag}: ${
        "message" in reconciled.error ? reconciled.error.message : ""
      }`,
    );
  }
}

const wss = new WebSocketServer({ port: config.port });

wss.on("connection", (ws, req) => {
  // Disable Nagle: large command/artifact responses cross a Docker published-port
  // (userland-proxy) hop where Nagle + delayed-ACK collapses throughput.
  req.socket.setNoDelay(true);
  handler.handleConnection(ws);
});

console.log(`Controller listening on ws://0.0.0.0:${config.port}`);
