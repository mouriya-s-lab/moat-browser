// Controller configuration — environment variables per design.md §8

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export const config = {
  // Required
  jwtSecret: requireEnv("MOAT_BROWSER_JWT_SECRET"),

  // Optional with defaults
  port: Number(process.env["MOAT_BROWSER_PORT"] ?? "9800"),
  dockerSocket: process.env["MOAT_BROWSER_DOCKER_SOCKET"] ?? "/var/run/docker.sock",
  profileDir: process.env["MOAT_BROWSER_PROFILE_DIR"] ?? "/data/profile",
  agentProfilesDir: process.env["MOAT_BROWSER_AGENT_PROFILES_DIR"] ?? "/data/agent-profiles",
  userChromeImage: process.env["MOAT_BROWSER_USER_CHROME_IMAGE"] ?? "moat-browser/user-chrome",
  agentChromeImage: process.env["MOAT_BROWSER_AGENT_CHROME_IMAGE"] ?? "moat-browser/agent-chrome",
  idleTimeoutMs: Number(process.env["MOAT_BROWSER_IDLE_TIMEOUT_MS"] ?? "300000"),
  reconnectTimeoutMs: Number(process.env["MOAT_BROWSER_RECONNECT_TIMEOUT_MS"] ?? "5000"),
  cleanupIntervalMs: Number(process.env["MOAT_BROWSER_CLEANUP_INTERVAL_MS"] ?? "300000"),
  dockerNetwork: process.env["MOAT_BROWSER_DOCKER_NETWORK"] ?? "moat-browser",
} as const;
