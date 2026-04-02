import { loadConfig } from "./config";
import { createServer } from "./socketio";

const config = loadConfig();
createServer(config);
