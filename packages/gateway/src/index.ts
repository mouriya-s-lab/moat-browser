import { createGateway } from "./socketio.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("moat-browser gateway starting...");

  const { httpServer } = createGateway();

  httpServer.listen(config.port, () => {
    console.log(`gateway listening on port ${config.port}`);
  });

  const shutdown = () => {
    console.log("gateway shutting down...");
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
