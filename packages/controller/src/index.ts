import { createServer } from "http";
import { loadConfig } from "./config";
import { createSocketServer } from "./socketio";

const config = loadConfig();
const httpServer = createServer();
const io = createSocketServer(httpServer, config);

httpServer.listen(config.port, () => {
  console.log(`[Controller] Socket.IO listening on port ${config.port}`);
});
