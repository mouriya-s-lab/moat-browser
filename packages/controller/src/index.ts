// Controller entry point — Socket.IO server + cleanup scheduler (design.md §4)
import { createServer } from "node:http";
import { config } from "./config.js";
import { createSocketIOServer } from "./socketio.js";
import { startCleanup } from "./cleanup.js";

const httpServer = createServer();
createSocketIOServer(httpServer);

const stopCleanup = startCleanup();

httpServer.listen(config.port, () => {
  console.log(`[controller] Socket.IO server listening on port ${config.port}`);
});

process.on("SIGTERM", () => {
  console.log("[controller] SIGTERM received, shutting down");
  stopCleanup();
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  stopCleanup();
  httpServer.close(() => process.exit(0));
});
