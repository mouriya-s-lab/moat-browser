import { Server } from "socket.io";
import type { GatewayError } from "@moat-browser/types";
import { validateBrowserCommand } from "@moat-browser/types";
import type { Config } from "./config";
import { verifyToken } from "./auth";
import { SessionRegistry } from "./session";
import {
  createAgentContainer,
  destroyAgentContainer,
  waitForCdp,
} from "./docker";
import type { CdpConnection } from "./cdp-bridge";
import { connectCdp, executeCommand, disconnectCdp } from "./cdp-bridge";
import {
  freezeProfile,
  unfreezeProfile,
  isProfileFrozen,
} from "./profile";

export function createServer(config: Config): Server {
  const io = new Server(config.port, {
    cors: { origin: "*" },
  });

  const registry = new SessionRegistry();
  const connections = new Map<string, CdpConnection>();

  io.on("connection", (socket) => {
    console.log(`[controller] socket connected: ${socket.id}`);

    socket.on(
      "freezeProfile",
      async (callback?: (res: unknown) => void) => {
        const result = await freezeProfile(config);
        if (result !== undefined) {
          if (callback) return callback(result);
          return socket.emit("error", result);
        }
        console.log("[controller] profile frozen");
        const response = { ok: true };
        if (callback) return callback(response);
        socket.emit("profileFrozen", response);
      }
    );

    socket.on(
      "unfreezeProfile",
      async (callback?: (res: unknown) => void) => {
        const result = await unfreezeProfile(config);
        if (result !== undefined) {
          if (callback) return callback(result);
          return socket.emit("error", result);
        }
        console.log("[controller] profile unfrozen");
        const response = { ok: true };
        if (callback) return callback(response);
        socket.emit("profileUnfrozen", response);
      }
    );

    socket.on(
      "profileStatus",
      async (callback?: (res: unknown) => void) => {
        const frozen = await isProfileFrozen(config);
        const response = { frozen };
        if (callback) return callback(response);
        socket.emit("profileStatus", response);
      }
    );

    socket.on(
      "register",
      async (token: unknown, callback?: (res: unknown) => void) => {
        if (typeof token !== "string") {
          const error: GatewayError = {
            _tag: "ValidationError",
            message: "Token must be a string",
          };
          if (callback) return callback(error);
          return socket.emit("error", error);
        }

        const payload = verifyToken(token, config.jwtSecret);
        if ("_tag" in payload) {
          if (callback) return callback(payload);
          return socket.emit("error", payload);
        }

        const session = registry.create(payload.agentId, socket.id);
        registry.transition(session.id, { _tag: "StartCreating" });

        const containerResult = await createAgentContainer(config, session.id);
        if ("_tag" in containerResult) {
          registry.transition(session.id, {
            _tag: "Error",
            message: "Container creation failed",
          });
          if (callback) return callback(containerResult);
          return socket.emit("error", containerResult);
        }

        session.containerId = containerResult.id;
        session.containerIp = containerResult.ip;
        registry.transition(session.id, { _tag: "ContainerCreated" });

        const cdpReady = await waitForCdp(containerResult.ip);
        if (!cdpReady) {
          registry.transition(session.id, {
            _tag: "Error",
            message: "CDP timeout",
          });
          const error: GatewayError = {
            _tag: "ContainerError",
            message: "CDP endpoint not reachable",
          };
          if (callback) return callback(error);
          return socket.emit("error", error);
        }

        const cdpResult = await connectCdp(
          `http://${containerResult.ip}:9222`
        );
        if ("_tag" in cdpResult) {
          registry.transition(session.id, {
            _tag: "Error",
            message: "CDP connection failed",
          });
          if (callback) return callback(cdpResult);
          return socket.emit("error", cdpResult);
        }

        connections.set(session.id, cdpResult);
        registry.transition(session.id, { _tag: "CdpConnected" });

        console.log(
          `[controller] agent registered: ${payload.agentId}, session: ${session.id}`
        );
        const response = { sessionId: session.id };
        if (callback) return callback(response);
        socket.emit("registered", response);
      }
    );

    socket.on(
      "command",
      async (data: unknown, callback?: (res: unknown) => void) => {
        const session = registry.getBySocketId(socket.id);
        if (!session) {
          const error: GatewayError = {
            _tag: "SessionNotFound",
            sessionId: "",
          };
          if (callback) return callback(error);
          return socket.emit("error", error);
        }

        if (session.state._tag !== "Active") {
          const error: GatewayError = {
            _tag: "SessionExpired",
            sessionId: session.id,
          };
          if (callback) return callback(error);
          return socket.emit("error", error);
        }

        const validated = validateBrowserCommand(data);
        if (validated._tag === "ValidationError") {
          if (callback) return callback(validated);
          return socket.emit("error", validated);
        }

        const conn = connections.get(session.id);
        if (!conn) {
          const error: GatewayError = {
            _tag: "ContainerError",
            message: "No CDP connection",
          };
          if (callback) return callback(error);
          return socket.emit("error", error);
        }

        session.lastActivityAt = Date.now();
        const result = await executeCommand(conn, validated);
        if (callback) return callback(result);
        socket.emit("result", result);
      }
    );

    socket.on("deregister", async (callback?: (res: unknown) => void) => {
      const session = registry.getBySocketId(socket.id);
      if (!session) {
        if (callback) return callback({ ok: true });
        return;
      }

      const conn = connections.get(session.id);
      if (conn) {
        await disconnectCdp(conn);
        connections.delete(session.id);
      }

      if (session.containerId) {
        await destroyAgentContainer(config, session.containerId, session.id);
      }

      registry.delete(session.id);
      console.log(
        `[controller] agent deregistered: ${session.agentId}, session: ${session.id}`
      );
      if (callback) return callback({ ok: true });
    });

    socket.on("disconnect", () => {
      const session = registry.getBySocketId(socket.id);
      if (!session || session.state._tag !== "Active") return;

      registry.transition(session.id, { _tag: "SocketDisconnected" });

      setTimeout(async () => {
        const s = registry.get(session.id);
        if (!s || s.state._tag !== "Reconnecting") return;

        registry.transition(session.id, { _tag: "ReconnectTimeout" });

        const conn = connections.get(session.id);
        if (conn) {
          await disconnectCdp(conn);
          connections.delete(session.id);
        }
        if (s.containerId) {
          await destroyAgentContainer(config, s.containerId, session.id);
        }
        registry.delete(session.id);
        console.log(
          `[controller] session expired (reconnect timeout): ${session.id}`
        );
      }, config.reconnectTimeoutMs);
    });
  });

  console.log(`[controller] listening on port ${config.port}`);
  return io;
}
