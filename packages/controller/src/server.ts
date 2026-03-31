import { createServer, type Socket } from "node:net";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { handleRequest } from "./handler.js";
import { config } from "./config.js";

export async function startServer(): Promise<void> {
  const socketPath = `${config.socketDir}/${config.controllerSocket}`;

  // Ensure socket directory exists
  await mkdir(dirname(socketPath), { recursive: true });

  // Remove stale socket file
  const { rm } = await import("node:fs/promises");
  await rm(socketPath, { force: true });

  const server = createServer(handleConnection);

  server.listen(socketPath, () => {
    console.log(`controller listening on ${socketPath}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("controller shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function handleConnection(socket: Socket): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    // Process complete JSON lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      processLine(line, socket);
    }
  });

  socket.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
      console.error("socket error:", err.message);
    }
  });
}

async function processLine(line: string, socket: Socket): Promise<void> {
  try {
    const raw = JSON.parse(line);
    const result = await handleRequest(raw);
    socket.write(JSON.stringify(result) + "\n");
  } catch (err) {
    const errorResponse = {
      _tag: "DockerError",
      message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
    socket.write(JSON.stringify(errorResponse) + "\n");
  }
}
