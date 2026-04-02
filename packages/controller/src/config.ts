export interface Config {
  readonly port: number;
  readonly jwtSecret: string;
  readonly dockerSocket: string;
  readonly agentChromeImage: string;
  readonly profileSourcePath: string;
  readonly profileBasePath: string;
  readonly idleTimeoutMs: number;
  readonly reconnectTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env["CONTROLLER_PORT"] ?? "3000"),
    jwtSecret: process.env["JWT_SECRET"] ?? "dev-secret",
    dockerSocket: process.env["DOCKER_SOCKET"] ?? "/var/run/docker.sock",
    agentChromeImage: process.env["AGENT_CHROME_IMAGE"] ?? "agent-chrome:latest",
    profileSourcePath: process.env["PROFILE_SOURCE_PATH"] ?? "/data/profile",
    profileBasePath: process.env["PROFILE_BASE_PATH"] ?? "/data/profiles",
    idleTimeoutMs: Number(process.env["IDLE_TIMEOUT_MS"] ?? "300000"),
    reconnectTimeoutMs: Number(process.env["RECONNECT_TIMEOUT_MS"] ?? "5000"),
  };
}
