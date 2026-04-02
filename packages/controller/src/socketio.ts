import { Server } from "socket.io";
import type { Server as HttpServer } from "http";
import { BrowserCommandSchema } from "@moat-browser/types";
import type { BrowserResult, GatewayError } from "@moat-browser/types";
import { verifyToken } from "./auth";
import { SessionRegistry } from "./session";
import { createAgentContainer, destroyAgentContainer, waitForCDP } from "./docker";
import { connectCDP, executeCommand } from "./cdp-bridge";
import type { Config } from "./config";

export function createSocketServer(httpServer: HttpServer, config: Config): Server {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  const registry = new SessionRegistry();

  io.on("connection", (socket) => {
    let currentSessionId: string | null = null;

    socket.on("register", async (token: unknown, callback?: (response: unknown) => void) => {
      const respond = (data: unknown) => {
        if (typeof callback === "function") {
          callback(data);
        } else {
          socket.emit("result", data);
        }
      };

      if (typeof token !== "string") {
        const err: GatewayError = { _tag: "ValidationError", message: "token must be a string" };
        respond(err);
        return;
      }

      // Verify JWT
      const authResult = await verifyToken(token, config.jwtSecret);
      if (authResult._tag === "AuthError") {
        respond(authResult);
        return;
      }

      const agentId = authResult.agentId;

      // Check for existing session
      const existing = registry.getByAgentId(agentId);
      if (existing && existing.state._tag !== "Expired") {
        respond({ _tag: "ValidationError", message: "agent already registered" } satisfies GatewayError);
        return;
      }

      // Create session
      const session = registry.create(agentId);
      currentSessionId = session.sessionId;

      // Transition: Registering → CreatingContainer
      registry.transition(session.sessionId, { _tag: "Register" });

      // Create agent-chrome container
      const containerResult = await createAgentContainer(session.sessionId, config);
      if (containerResult._tag === "ContainerError") {
        registry.transition(session.sessionId, { _tag: "Deregister" });
        registry.remove(session.sessionId);
        currentSessionId = null;
        respond(containerResult);
        return;
      }

      session.containerId = containerResult.value.id;
      session.containerIp = containerResult.value.ip;

      // Transition: CreatingContainer → ConnectingCDP
      registry.transition(session.sessionId, { _tag: "ContainerCreated" });

      // Wait for CDP to be ready
      const cdpReady = await waitForCDP(containerResult.value.ip);
      if (cdpReady._tag === "ContainerError") {
        await destroyAgentContainer(session.sessionId, config);
        registry.transition(session.sessionId, { _tag: "Deregister" });
        registry.remove(session.sessionId);
        currentSessionId = null;
        respond(cdpReady);
        return;
      }

      // Connect Patchright via CDP
      const cdpConn = await connectCDP(containerResult.value.ip);
      if (cdpConn._tag === "CommandError") {
        await destroyAgentContainer(session.sessionId, config);
        registry.transition(session.sessionId, { _tag: "Deregister" });
        registry.remove(session.sessionId);
        currentSessionId = null;
        respond({ _tag: "ContainerError", message: cdpConn.message } satisfies GatewayError);
        return;
      }

      session.cdpConnection = cdpConn.connection;

      // Transition: ConnectingCDP → Active
      registry.transition(session.sessionId, { _tag: "CDPConnected" });

      // Start idle timer
      const onExpired = async () => {
        if (session.cdpConnection) {
          await session.cdpConnection.browser.close().catch(() => {});
        }
        await destroyAgentContainer(session.sessionId, config);
        registry.remove(session.sessionId);
      };
      registry.startIdleTimer(session.sessionId, config, onExpired);

      respond({ sessionId: session.sessionId });
    });

    socket.on("resume", (sessionId: unknown, callback?: (response: unknown) => void) => {
      const respond = (data: unknown) => {
        if (typeof callback === "function") {
          callback(data);
        } else {
          socket.emit("result", data);
        }
      };

      if (typeof sessionId !== "string") {
        respond({ _tag: "ValidationError", message: "sessionId must be a string" } satisfies GatewayError);
        return;
      }

      const entry = registry.getBySessionId(sessionId);
      if ("_tag" in entry) {
        respond(entry);
        return;
      }

      if (entry.state._tag === "Reconnecting") {
        registry.clearReconnectTimer(sessionId);
        registry.transition(sessionId, { _tag: "SocketReconnected" });
        currentSessionId = sessionId;
        respond({ sessionId });
      } else {
        respond({ _tag: "SessionExpired", sessionId } satisfies GatewayError);
      }
    });

    socket.on("command", async (data: unknown, callback?: (response: unknown) => void) => {
      const respond = (data: unknown) => {
        if (typeof callback === "function") {
          callback(data);
        } else {
          socket.emit("result", data);
        }
      };

      if (!currentSessionId) {
        respond({ _tag: "SessionNotFound", sessionId: "" } satisfies GatewayError);
        return;
      }

      const entry = registry.getBySessionId(currentSessionId);
      if ("_tag" in entry) {
        respond(entry);
        return;
      }

      if (entry.state._tag !== "Active") {
        respond({ _tag: "SessionExpired", sessionId: currentSessionId } satisfies GatewayError);
        return;
      }

      // Validate command with arktype
      const validated = BrowserCommandSchema(data);
      if (validated instanceof type.errors) {
        respond({
          _tag: "ValidationError",
          message: validated.summary,
        } satisfies GatewayError);
        return;
      }

      if (!entry.cdpConnection) {
        respond({
          _tag: "CommandError",
          command: validated._tag,
          message: "no CDP connection",
        } satisfies GatewayError);
        return;
      }

      // Reset idle timer
      const onExpired = async () => {
        if (entry.cdpConnection) {
          await entry.cdpConnection.browser.close().catch(() => {});
        }
        await destroyAgentContainer(entry.sessionId, config);
        registry.remove(entry.sessionId);
      };
      registry.resetIdleTimer(currentSessionId, config, onExpired);

      // Execute command
      const result = await executeCommand(entry.cdpConnection, validated);
      respond(result);
    });

    socket.on("deregister", async (callback?: (response: unknown) => void) => {
      const respond = (data: unknown) => {
        if (typeof callback === "function") {
          callback(data);
        } else {
          socket.emit("result", data);
        }
      };

      if (!currentSessionId) {
        respond({ _tag: "SessionNotFound", sessionId: "" } satisfies GatewayError);
        return;
      }

      const sessionId = currentSessionId;
      const entry = registry.getBySessionId(sessionId);

      if (!("_tag" in entry)) {
        // Close CDP connection
        if (entry.cdpConnection) {
          await entry.cdpConnection.browser.close().catch(() => {});
        }

        // Transition to Expired
        registry.transition(sessionId, { _tag: "Deregister" });

        // Destroy container
        await destroyAgentContainer(sessionId, config);

        // Remove session
        registry.remove(sessionId);
      }

      currentSessionId = null;
      respond({ ok: true });
    });

    socket.on("disconnect", () => {
      if (currentSessionId) {
        const entry = registry.getBySessionId(currentSessionId);
        if (!("_tag" in entry) && entry.state._tag === "Active") {
          registry.transition(currentSessionId, { _tag: "SocketDisconnected" });

          const sessionId = currentSessionId;
          const onExpired = async () => {
            const e = registry.getBySessionId(sessionId);
            if (!("_tag" in e) && e.cdpConnection) {
              await e.cdpConnection.browser.close().catch(() => {});
            }
            await destroyAgentContainer(sessionId, config);
            registry.remove(sessionId);
          };
          registry.startReconnectTimer(currentSessionId, config, onExpired);
        }
      }
    });
  });

  return io;
}

// Need arktype's type for error checking
import { type } from "arktype";
