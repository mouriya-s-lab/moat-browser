export interface Config {
  readonly port: number;
  readonly jwtSecret: string;
  readonly dockerSocket: string;
  readonly profileSourceDir: string;
  readonly profilesDir: string;
  readonly agentChromeImage: string;
  readonly idleTimeoutMs: number;
  readonly reconnectTimeoutMs: number;
  readonly dockerNetwork: string | undefined;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
    dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    profileSourceDir: process.env.PROFILE_SOURCE_DIR ?? "/data/profile",
    profilesDir: process.env.PROFILES_DIR ?? "/data/profiles",
    agentChromeImage: process.env.AGENT_CHROME_IMAGE ?? "moat-agent-chrome",
    idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS ?? "300000", 10),
    reconnectTimeoutMs: parseInt(process.env.RECONNECT_TIMEOUT_MS ?? "5000", 10),
    dockerNetwork: process.env.DOCKER_NETWORK ?? undefined,
  };
}
