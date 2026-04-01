/**
 * socketio.ts — Socket.IO Server
 *
 * Handles register / resume / command / deregister events.
 * All messages validated via arktype schemas.
 * JWT auth enforced on connection.
 */

import { createServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { type } from "arktype";
import {
  BrowserCommandSchema,
  RegisterEventSchema,
  ResumeEventSchema,
  DeregisterEventSchema,
} from "@moat-browser/types";
import type { GatewayError, BrowserResult } from "@moat-browser/types";
import { verifyToken } from "./auth.js";
import { SessionRegistry } from "./session-registry.js";
import { createAgentChrome, destroyAgentChrome, waitForCDP } from "./docker.js";
import { CDPBridge } from "./cdp-bridge.js";
import { config } from "./config.js";
import { cp, rm } from "fs/promises";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerToClientEvents {
  error: (err: GatewayError) => void;
  registered: (data: { sessionId: string }) => void;
  resumed: (data: { sessionId: string }) => void;
  result: (data: BrowserResult) => void;
  deregistered: (data: { sessionId: string }) => void;
}

interface ClientToServerEvents {
  register: (data: unknown, cb?: (err: GatewayError | null, result?: { sessionId: string }) => void) => void;
  resume: (data: unknown, cb?: (err: GatewayError | null, result?: { sessionId: string }) => void) => void;
  command: (data: unknown, cb?: (err: GatewayError | null, result?: BrowserResult) => void) => void;
  deregister: (data: unknown, cb?: (err: GatewayError | null, result?: { sessionId: string }) => void) => void;
}

// ---------------------------------------------------------------------------
// ControllerServer
// ---------------------------------------------------------------------------

export class ControllerServer {
  private readonly registry: SessionRegistry;
  private readonly bridges = new Map<string, CDPBridge>();
  private readonly httpServer: ReturnType<typeof createServer>;
  readonly io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;

  constructor(registry?: SessionRegistry) {
    this.registry = registry ?? new SessionRegistry();
    this.httpServer = createServer();
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: "*" },
    });

    this.io.use(this._authMiddleware.bind(this));
    this.io.on("connection", this._handleConnection.bind(this));
  }

  /** Start listening on configured port. */
  listen(port: number = config.port): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(port, () => {
        console.log(`[controller] Socket.IO server listening on :${port}`);
        resolve();
      });
    });
  }

  /** Stop the server. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.io.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------

  private async _authMiddleware(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    next: (err?: Error) => void
  ): Promise<void> {
    const token =
      (socket.handshake.auth as Record<string, unknown>)["token"] as string | undefined ??
      socket.handshake.headers["authorization"]?.replace("Bearer ", "");

    if (!token) {
      next(new Error("AuthError: missing token"));
      return;
    }

    const result = await verifyToken(token);
    if (!result.ok) {
      next(new Error(`AuthError: ${result.error.message}`));
      return;
    }

    // Attach agentId to socket data
    (socket.data as Record<string, unknown>)["agentId"] = result.payload.agentId;
    next();
  }

  // -------------------------------------------------------------------------
  // Connection handler
  // -------------------------------------------------------------------------

  private _handleConnection(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>
  ): void {
    const agentId = (socket.data as Record<string, unknown>)["agentId"] as string;
    console.log(`[controller] client connected: ${socket.id} agentId=${agentId}`);

    socket.on("register", (data, cb) => void this._onRegister(socket, agentId, data, cb));
    socket.on("resume", (data, cb) => void this._onResume(socket, data, cb));
    socket.on("command", (data, cb) => void this._onCommand(socket, data, cb));
    socket.on("deregister", (data, cb) => void this._onDeregister(socket, data, cb));
    socket.on("disconnect", () => this._onDisconnect(socket, agentId));
  }

  // -------------------------------------------------------------------------
  // Event: register
  // -------------------------------------------------------------------------

  private async _onRegister(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    agentId: string,
    data: unknown,
    cb?: (err: GatewayError | null, result?: { sessionId: string }) => void
  ): Promise<void> {
    const parsed = RegisterEventSchema(data);
    if (parsed instanceof type.errors) {
      const err: GatewayError = { _tag: "ValidationError", message: parsed.summary };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    // Create session
    const { sessionId } = this.registry.create(agentId);

    // Copy profile
    const profileSrc = `${config.profileBaseDir}/${agentId}`;
    const profileDst = `${config.profileAgentsDir}/${agentId}-${sessionId}`;

    if (existsSync(profileSrc)) {
      try {
        await cp(profileSrc, profileDst, { recursive: true });
      } catch (e) {
        console.warn(`[controller] profile copy failed for ${agentId}: ${String(e)}`);
      }
    }

    // Drive state: Registering → CreatingContainer
    this.registry.dispatch(sessionId, {
      _tag: "ContainerCreated",
      containerId: "",
      containerIp: "",
    });

    // Create container
    let containerInfo: Awaited<ReturnType<typeof createAgentChrome>>;
    try {
      containerInfo = await createAgentChrome(agentId);
    } catch (e) {
      this.registry.delete(sessionId);
      const err: GatewayError = {
        _tag: "ContainerError",
        message: `Failed to create container: ${String(e)}`,
      };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    // Drive state: CreatingContainer → ConnectingCDP
    this.registry.dispatch(sessionId, {
      _tag: "ContainerCreated",
      containerId: containerInfo.containerId,
      containerIp: containerInfo.containerIp,
    });

    // Wait for CDP
    try {
      await waitForCDP(containerInfo.containerIp, config.cdpPort, 30_000);
    } catch (e) {
      await destroyAgentChrome(containerInfo.containerId, profileDst).catch(() => {});
      this.registry.delete(sessionId);
      const err: GatewayError = {
        _tag: "CDPError",
        message: `CDP not ready: ${String(e)}`,
      };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    // Connect CDP bridge
    const bridge = new CDPBridge();
    try {
      await bridge.connect(containerInfo.containerIp, config.cdpPort, (reason) => {
        this.registry.dispatch(sessionId, { _tag: "CDPDisconnected", reason });
      });
    } catch (e) {
      await destroyAgentChrome(containerInfo.containerId, profileDst).catch(() => {});
      this.registry.delete(sessionId);
      const err: GatewayError = {
        _tag: "CDPError",
        message: `CDP connect failed: ${String(e)}`,
      };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    this.bridges.set(sessionId, bridge);

    // Drive state: ConnectingCDP → Active
    this.registry.dispatch(sessionId, { _tag: "CDPConnected", sessionId });

    // Store sessionId on socket
    (socket.data as Record<string, unknown>)["sessionId"] = sessionId;

    const result = { sessionId };
    if (cb) {
      cb(null, result);
    } else {
      socket.emit("registered", result);
    }
  }

  // -------------------------------------------------------------------------
  // Event: resume
  // -------------------------------------------------------------------------

  private async _onResume(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    data: unknown,
    cb?: (err: GatewayError | null, result?: { sessionId: string }) => void
  ): Promise<void> {
    const parsed = ResumeEventSchema(data);
    if (parsed instanceof type.errors) {
      const err: GatewayError = { _tag: "ValidationError", message: parsed.summary };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const { sessionId } = parsed;
    const state = this.registry.get(sessionId);

    if (state === undefined) {
      const err: GatewayError = { _tag: "SessionNotFound", sessionId };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    if (state._tag === "Expired" || state._tag === "Destroyed") {
      const err: GatewayError = { _tag: "SessionExpired", sessionId };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    // Drive reconnect
    if (state._tag === "Reconnecting") {
      this.registry.dispatch(sessionId, { _tag: "SocketReconnected" });
    }

    (socket.data as Record<string, unknown>)["sessionId"] = sessionId;

    const result = { sessionId };
    if (cb) {
      cb(null, result);
    } else {
      socket.emit("resumed", result);
    }
  }

  // -------------------------------------------------------------------------
  // Event: command
  // -------------------------------------------------------------------------

  private async _onCommand(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    data: unknown,
    cb?: (err: GatewayError | null, result?: BrowserResult) => void
  ): Promise<void> {
    const parsed = BrowserCommandSchema(data);
    if (parsed instanceof type.errors) {
      const err: GatewayError = { _tag: "ValidationError", message: parsed.summary };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const sessionId = (socket.data as Record<string, unknown>)["sessionId"] as string | undefined;
    if (!sessionId) {
      const err: GatewayError = { _tag: "SessionNotFound", sessionId: "<none>" };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const state = this.registry.get(sessionId);
    if (!state || state._tag !== "Active") {
      const err: GatewayError = { _tag: "SessionExpired", sessionId };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const bridge = this.bridges.get(sessionId);
    if (!bridge) {
      const err: GatewayError = { _tag: "CDPError", message: "Bridge not found" };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    // Record activity
    this.registry.dispatch(sessionId, { _tag: "ActivityRecorded", at: Date.now() });

    const execResult = await bridge.execute(parsed);
    if ("_tag" in execResult && (execResult as GatewayError)._tag.endsWith("Error")) {
      const err = execResult as GatewayError;
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const result = execResult as BrowserResult;
    if (cb) {
      cb(null, result);
    } else {
      socket.emit("result", result);
    }
  }

  // -------------------------------------------------------------------------
  // Event: deregister
  // -------------------------------------------------------------------------

  private async _onDeregister(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    data: unknown,
    cb?: (err: GatewayError | null, result?: { sessionId: string }) => void
  ): Promise<void> {
    const parsed = DeregisterEventSchema(data);
    if (parsed instanceof type.errors) {
      const err: GatewayError = { _tag: "ValidationError", message: parsed.summary };
      cb ? cb(err) : socket.emit("error", err);
      return;
    }

    const { sessionId } = parsed;
    await this._cleanupSession(sessionId);

    const result = { sessionId };
    if (cb) {
      cb(null, result);
    } else {
      socket.emit("deregistered", result);
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect handler
  // -------------------------------------------------------------------------

  private _onDisconnect(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    agentId: string
  ): void {
    console.log(`[controller] client disconnected: ${socket.id} agentId=${agentId}`);
    const sessionId = (socket.data as Record<string, unknown>)["sessionId"] as string | undefined;
    if (sessionId) {
      this.registry.dispatch(sessionId, { _tag: "SocketDisconnected" });
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup helpers
  // -------------------------------------------------------------------------

  async _cleanupSession(sessionId: string): Promise<void> {
    const state = this.registry.get(sessionId);
    if (!state) return;

    // Disconnect CDP bridge
    const bridge = this.bridges.get(sessionId);
    if (bridge) {
      await bridge.disconnect().catch(() => {});
      this.bridges.delete(sessionId);
    }

    // Destroy container
    const containerId =
      "containerId" in state ? (state as { containerId: string }).containerId : undefined;
    const profilePath =
      "profilePath" in state ? (state as { profilePath: string }).profilePath : undefined;
    if (containerId) {
      await destroyAgentChrome(containerId, profilePath ?? "").catch(() => {});
    } else if (profilePath) {
      // No container but profile exists — remove manually
      await rm(profilePath, { recursive: true, force: true }).catch(() => {});
    }

    // Drive to Destroyed
    this.registry.dispatch(sessionId, { _tag: "CleanupComplete" });
    this.registry.delete(sessionId);
  }

  /** Return registry for external access (e.g., cleanup). */
  getRegistry(): SessionRegistry {
    return this.registry;
  }

  /** Return bridges map. */
  getBridges(): Map<string, CDPBridge> {
    return this.bridges;
  }
}
