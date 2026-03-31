import { createServer } from "node:http";
import { Server } from "socket.io";
import { verifyToken } from "./auth.js";
import { handleClientEvent } from "./handler.js";
import * as sessionMgr from "./session.js";
import { sendToController } from "./controller-client.js";
import { isNekoRequest, handleNekoProxy } from "./neko-proxy.js";
import { config } from "./config.js";

export function createGateway() {
  const httpServer = createServer((req, res) => {
    // neko reverse proxy
    if (isNekoRequest(req)) {
      handleNekoProxy(req, res);
      return;
    }
    // Health endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
  });
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    maxHttpBufferSize: config.maxHttpBufferSize,
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.["token"] as string | undefined;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    const result = verifyToken(token);
    if (result._tag === "Valid") {
      socket.data.agentId = result.agentId;
      next();
    } else {
      next(new Error(`Authentication failed: ${result.reason}`));
    }
  });

  io.on("connection", (socket) => {
    console.log(`client connected: ${socket.id}`);

    socket.on("event", async (raw: unknown, ack?: (response: unknown) => void) => {
      const response = await handleClientEvent(socket, raw);
      if (ack) {
        ack(response);
      } else {
        socket.emit("event", response);
      }
    });

    socket.on("disconnect", async (reason) => {
      console.log(`client disconnected: ${socket.id} (${reason})`);

      // Grace period before cleanup
      const sessions = sessionMgr.removeSessionsBySocketId(socket.id);
      for (const session of sessions) {
        session.disconnectTimer = setTimeout(async () => {
          console.log(`cleaning up session ${session.sessionId} (agent: ${session.agentId})`);
          try {
            await sendToController({
              _tag: "DestroyAgentBrowser",
              agentId: session.agentId,
            });
          } catch (err) {
            console.error(`cleanup error for ${session.agentId}:`, err);
          }
        }, config.disconnectGraceMs);
      }
    });
  });

  return { httpServer, io };
}
