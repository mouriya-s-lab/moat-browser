import { WebSocketServer } from "ws";
import { createSessionRegistry } from "./session-registry.js";
import { createContainerManager } from "./container-manager.js";
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
  readonly reconnectWindow: number;
  readonly cdpReadyTimeout: number;
  readonly commandTimeout: number;
};

function loadConfig(): ControllerConfig {
  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    profileSource: process.env.PROFILE_SOURCE ?? "/data/profile",
    profilesWork: process.env.PROFILES_WORK ?? "/data/profiles",
    profilesHostPath: process.env.PROFILES_HOST_PATH ?? process.env.PROFILES_WORK ?? "/data/profiles",
    dockerNetwork: process.env.DOCKER_NETWORK ?? "moat",
    agentChromeImage: process.env.AGENT_CHROME_IMAGE ?? "agent-chrome:latest",
    sessionIdleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT ?? "600000", 10),
    reconnectWindow: parseInt(process.env.RECONNECT_WINDOW ?? "120000", 10),
    cdpReadyTimeout: parseInt(process.env.CDP_READY_TIMEOUT ?? "30000", 10),
    commandTimeout: parseInt(process.env.COMMAND_TIMEOUT ?? "25000", 10),
  };
}

// ─── Entry ───

const config = loadConfig();

const containerManager = createContainerManager({
  profileSource: config.profileSource,
  profilesWork: config.profilesWork,
  profilesHostPath: config.profilesHostPath,
  dockerNetwork: config.dockerNetwork,
  agentChromeImage: config.agentChromeImage,
  cdpReadyTimeout: config.cdpReadyTimeout,
});

const refStore = createRefStore();

const registry = createSessionRegistry(
  {
    sessionIdleTimeout: config.sessionIdleTimeout,
    reconnectTimeout: config.reconnectWindow,
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

const wss = new WebSocketServer({ port: config.port });

wss.on("connection", (ws) => {
  handler.handleConnection(ws);
});

console.log(`Controller listening on ws://0.0.0.0:${config.port}`);
