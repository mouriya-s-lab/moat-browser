/**
 * index.ts — Controller entry point
 *
 * Starts the Socket.IO server and cleanup scheduler.
 */

import { ControllerServer } from "./socketio.js";
import { CleanupScheduler } from "./cleanup.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const server = new ControllerServer();
  const cleanup = new CleanupScheduler(server);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[controller] received ${signal}, shutting down...`);
    cleanup.stop();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await server.listen(config.port);
  cleanup.start();

  console.log("[controller] ready");
}

main().catch((e) => {
  console.error("[controller] fatal error:", e);
  process.exit(1);
});
