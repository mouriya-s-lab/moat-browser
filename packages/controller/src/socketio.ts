// Socket.IO Server — handshake JWT auth + event handlers (design.md §4.3)
import { Server, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import {
  BrowserCommandSchema,
  RegisterPayloadSchema,
  ResumePayloadSchema,
  DeregisterPayloadSchema,
} from "@moat-browser/types";
import type { GatewayError } from "@moat-browser/types";
import { type } from "arktype";
import { config } from "./config.js";
import { verifyJWT } from "./auth.js";
import {
  createSession,
  getSession,
  applyEvent,
  attachConnection,
  detachConnection,
  deleteSession,
  setReconnectTimer,
  clearIdleTimer,
  setIdleTimer,
  listSessions,
} from "./session.js";
import { createAgentChrome, destroyAgentChrome, inspectContainer, waitForCDP } from "./docker.js";
import { connect, executeCommand, disconnect } from "./cdp-bridge.js";

// Map: socket.id → sessionId (for disconnect handling)
const socketToSession = new Map<string, string>();

function sendError(socket: Socket, err: GatewayError): void {
  socket.emit("error", err);
}

export function createSocketIOServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // Handshake JWT authentication
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as unknown;
    if (typeof token !== "string") {
      return next(new Error("AuthenticationFailed: missing token"));
    }

    const payload = await verifyJWT(token, config.jwtSecret);
    if ("_tag" in payload && payload._tag === "AuthenticationFailed") {
      return next(new Error(`AuthenticationFailed: ${payload.reason}`));
    }

    // Attach validated payload to socket data
    socket.data.tokenPayload = payload;
    next();
  });

  io.on("connection", (socket) => {
    // ---- register ----
    socket.on("register", async (raw, ack) => {
      const parsed = RegisterPayloadSchema(raw);
      if (parsed instanceof type.errors) {
        const err: GatewayError = { _tag: "InternalError", message: `Invalid register payload: ${parsed.summary}` };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      const { agentId } = parsed;

      // Create session in Registering state
      const sessionId = createSession(agentId);
      socketToSession.set(socket.id, sessionId);

      // Create agent-chrome container
      const containerResult = await createAgentChrome(agentId);
      if ("_tag" in containerResult) {
        applyEvent(sessionId, { _tag: "CleanupComplete" });
        deleteSession(sessionId);
        socketToSession.delete(socket.id);
        return typeof ack === "function" ? ack(containerResult) : sendError(socket, containerResult);
      }

      const { containerId, profilePath } = containerResult;
      applyEvent(sessionId, { _tag: "ContainerCreated", containerId });

      // Wait for CDP
      const inspectResult = await inspectContainer(containerId);
      if ("_tag" in inspectResult) {
        await destroyAgentChrome(containerId, profilePath);
        applyEvent(sessionId, { _tag: "CleanupComplete" });
        deleteSession(sessionId);
        socketToSession.delete(socket.id);
        return typeof ack === "function" ? ack(inspectResult) : sendError(socket, inspectResult);
      }

      const cdpReady = await waitForCDP(inspectResult.ip, 9222, 30_000);
      if ("_tag" in cdpReady) {
        await destroyAgentChrome(containerId, profilePath);
        applyEvent(sessionId, { _tag: "CleanupComplete" });
        deleteSession(sessionId);
        socketToSession.delete(socket.id);
        return typeof ack === "function" ? ack(cdpReady) : sendError(socket, cdpReady);
      }

      // Connect CDP
      const conn = await connect(inspectResult.ip);
      if ("_tag" in conn) {
        await destroyAgentChrome(containerId, profilePath);
        applyEvent(sessionId, { _tag: "CleanupComplete" });
        deleteSession(sessionId);
        socketToSession.delete(socket.id);
        return typeof ack === "function" ? ack(conn) : sendError(socket, conn);
      }

      applyEvent(sessionId, { _tag: "CDPConnected", sessionId });
      attachConnection(sessionId, conn);

      // Store containerId + profilePath for cleanup
      const entry = getSession(sessionId);
      if (entry) {
        (entry as Record<string, unknown>)["containerId"] = containerId;
        (entry as Record<string, unknown>)["profilePath"] = profilePath;
      }

      const result = { _tag: "RegisterResult" as const, sessionId, containerId };
      typeof ack === "function" ? ack(result) : socket.emit("registered", result);
    });

    // ---- resume ----
    socket.on("resume", async (raw, ack) => {
      const parsed = ResumePayloadSchema(raw);
      if (parsed instanceof type.errors) {
        const err: GatewayError = { _tag: "InternalError", message: `Invalid resume payload: ${parsed.summary}` };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      const { sessionId } = parsed;
      const entry = getSession(sessionId);
      if (!entry || entry.state._tag !== "Reconnecting") {
        const err: GatewayError = { _tag: "SessionNotFound", sessionId };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      socketToSession.set(socket.id, sessionId);
      const transition = applyEvent(sessionId, { _tag: "ResumeReceived" });
      if (!transition.ok) {
        return typeof ack === "function" ? ack(transition.error) : sendError(socket, transition.error);
      }

      const result = { _tag: "ResumeResult" as const, sessionId };
      typeof ack === "function" ? ack(result) : socket.emit("resumed", result);
    });

    // ---- command ----
    socket.on("command", async (raw, ack) => {
      const sessionId = socketToSession.get(socket.id);
      if (!sessionId) {
        const err: GatewayError = { _tag: "SessionNotReady", state: "no session" };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      const entry = getSession(sessionId);
      if (!entry || entry.state._tag !== "Active") {
        const err: GatewayError = { _tag: "SessionNotReady", state: entry?.state._tag ?? "none" };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      const parsed = BrowserCommandSchema(raw);
      if (parsed instanceof type.errors) {
        const err: GatewayError = { _tag: "InternalError", message: `Invalid command: ${parsed.summary}` };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      if (!entry.conn) {
        const err: GatewayError = { _tag: "CDPError", message: "No CDP connection" };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      // Reset idle timer on command
      applyEvent(sessionId, { _tag: "CommandReceived" });
      clearIdleTimer(sessionId);
      setIdleTimer(sessionId, config.idleTimeoutMs, () => {
        applyEvent(sessionId, { _tag: "IdleTimerFired" });
        socket.emit("sessionExpired", { reason: "IdleTimeout" });
      });

      const result = await executeCommand(entry.conn, parsed);
      typeof ack === "function" ? ack(result) : socket.emit("result", result);
    });

    // ---- deregister ----
    socket.on("deregister", async (raw, ack) => {
      const parsed = DeregisterPayloadSchema(raw);
      if (parsed instanceof type.errors) {
        const err: GatewayError = { _tag: "InternalError", message: `Invalid deregister payload: ${parsed.summary}` };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      const { sessionId } = parsed;
      const entry = getSession(sessionId);
      if (!entry) {
        const err: GatewayError = { _tag: "SessionNotFound", sessionId };
        return typeof ack === "function" ? ack(err) : sendError(socket, err);
      }

      // Close CDP
      const conn = detachConnection(sessionId);
      if (conn) await disconnect(conn);

      // Destroy container
      const containerId = (entry as Record<string, unknown>)["containerId"] as string | undefined;
      const profilePath = (entry as Record<string, unknown>)["profilePath"] as string | undefined;
      if (containerId && profilePath) {
        await destroyAgentChrome(containerId, profilePath);
      }

      socketToSession.delete(socket.id);
      applyEvent(sessionId, { _tag: "CleanupComplete" });
      deleteSession(sessionId);

      const result = { _tag: "DeregisterResult" as const, sessionId };
      typeof ack === "function" ? ack(result) : socket.emit("deregistered", result);
    });

    // ---- disconnect ----
    socket.on("disconnect", () => {
      const sessionId = socketToSession.get(socket.id);
      socketToSession.delete(socket.id);
      if (!sessionId) return;

      const entry = getSession(sessionId);
      if (!entry) return;

      if (entry.state._tag === "Active") {
        applyEvent(sessionId, { _tag: "SocketDisconnected" });
        // Start reconnect timer
        setReconnectTimer(sessionId, config.reconnectTimeoutMs, () => {
          applyEvent(sessionId, { _tag: "ReconnectTimerFired" });
          // Cleanup will handle Expired sessions on next interval
        });
      }
    });
  });

  return io;
}
