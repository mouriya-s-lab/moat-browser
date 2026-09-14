import { WebSocketServer } from "ws";
import { createSessionRegistry } from "./session-registry.js";
import { createContainerManager, resolveControllerOwner } from "./container-manager.js";
import { createRefStore } from "./ref-store.js";
import { createWsHandler } from "./ws-server.js";

// ─── ControllerConfig ───

export type ControllerConfig = {
  readonly port: number;
  readonly profileSource: string;
  readonly profilesWork: string;
  readonly profilesHostPath: string;
  readonly dockerNetwork: string;
  readonly agentChromeImage: string;
  readonly sessionIdleTimeout: number;
  readonly cdpReadyTimeout: number;
  readonly commandTimeout: number;
  readonly controllerOwner: string;
};

async function loadConfig(): Promise<ControllerConfig> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const dockerNetwork = process.env.DOCKER_NETWORK ?? "moat";
  const ownerResult = await resolveControllerOwner(process.env.CONTROLLER_OWNER);
  if (ownerResult._tag === "Err") {
    console.error(`[controller-owner] ${ownerResult.error.message}`);
    process.exit(78);
  }

  return {
    port,
    profileSource: process.env.PROFILE_SOURCE ?? "/data/profile",
    profilesWork: process.env.PROFILES_WORK ?? "/data/profiles",
    profilesHostPath: process.env.PROFILES_HOST_PATH ?? process.env.PROFILES_WORK ?? "/data/profiles",
    dockerNetwork,
    agentChromeImage: process.env.AGENT_CHROME_IMAGE ?? "agent-chrome:latest",
    sessionIdleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT ?? "600000", 10),
    cdpReadyTimeout: parseInt(process.env.CDP_READY_TIMEOUT ?? "30000", 10),
    commandTimeout: parseInt(process.env.COMMAND_TIMEOUT ?? "25000", 10),
    controllerOwner: ownerResult.value,
  };
}

// ─── Entry ───

const config = await loadConfig();

const containerManager = createContainerManager({
  profileSource: config.profileSource,
  profilesWork: config.profilesWork,
  profilesHostPath: config.profilesHostPath,
  dockerNetwork: config.dockerNetwork,
  agentChromeImage: config.agentChromeImage,
  cdpReadyTimeout: config.cdpReadyTimeout,
  owner: config.controllerOwner,
});

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

const wss = new WebSocketServer({ port: config.port });

wss.on("connection", (ws) => {
  handler.handleConnection(ws);
});

console.log(`Controller listening on ws://0.0.0.0:${config.port}`);
