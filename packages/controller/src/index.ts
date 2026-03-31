import { startServer } from "./server.js";
import { startCleanup } from "./cleanup.js";

async function main(): Promise<void> {
  console.log("moat-browser controller starting...");

  startCleanup();
  await startServer();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
