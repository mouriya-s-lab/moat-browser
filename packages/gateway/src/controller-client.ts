import { connect } from "node:net";
import type { ControllerRequest, ControllerResult, ControllerError } from "@moat-browser/types";
import { config } from "./config.js";

export async function sendToController(
  req: ControllerRequest
): Promise<ControllerResult | ControllerError> {
  return new Promise((resolve, reject) => {
    const socket = connect(config.controllerSocket);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`Failed to parse controller response: ${err}`));
        }
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`Controller connection failed: ${err.message}`));
    });

    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("Controller request timeout"));
    });
  });
}
