import { io } from "socket.io-client";
import type { GatewayError } from "@moat-browser/types";
import { BrowserClient, validateRegisterResponse } from "./client";

export { BrowserClient } from "./client";
export type { GatewayError, BrowserResult, BrowserCommand } from "@moat-browser/types";

export async function connect(
  url: string,
  token: string
): Promise<BrowserClient | GatewayError> {
  const socket = io(url, {
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 3,
    timeout: 10000,
  });

  return new Promise<BrowserClient | GatewayError>((resolve) => {
    socket.on("connect_error", (err) => {
      socket.disconnect();
      resolve({
        _tag: "ContainerError",
        message: `Connection failed: ${err.message}`,
      });
    });

    socket.on("connect", () => {
      socket.emit("register", token, (response: unknown) => {
        const validated = validateRegisterResponse(response);
        if ("_tag" in validated) {
          socket.disconnect();
          resolve(validated);
          return;
        }
        resolve(new BrowserClient(validated.sessionId, socket));
      });
    });

    socket.connect();
  });
}
