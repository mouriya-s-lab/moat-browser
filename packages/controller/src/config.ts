/**
 * config.ts — Environment variable configuration for the Controller
 */

export const config = {
  /** Port for Socket.IO server */
  port: parseInt(process.env["PORT"] ?? "9900", 10),

  /** JWT secret for verifying agent tokens */
  jwtSecret: process.env["MOAT_BROWSER_JWT_SECRET"] ?? "dev-secret-change-in-prod",

  /** Docker socket path */
  dockerSocket: process.env["DOCKER_SOCKET"] ?? "/var/run/docker.sock",

  /** agent-chrome Docker image */
  agentChromeImage: process.env["AGENT_CHROME_IMAGE"] ?? "moat-browser/agent-chrome:latest",

  /** Docker network name */
  dockerNetwork: process.env["DOCKER_NETWORK"] ?? "moat-browser",

  /** Base profile directory (read-only, user profiles) */
  profileBaseDir: process.env["PROFILE_BASE_DIR"] ?? "/data/profiles/base",

  /** Agent profile directory (copies per-agent) */
  profileAgentsDir: process.env["PROFILE_AGENTS_DIR"] ?? "/data/profiles/agents",

  /** CDP port on agent-chrome containers */
  cdpPort: parseInt(process.env["CDP_PORT"] ?? "9222", 10),

  /** Session idle timeout in milliseconds (default: 30 minutes) */
  sessionIdleTimeoutMs: parseInt(process.env["SESSION_IDLE_TIMEOUT_MS"] ?? "1800000", 10),

  /** Reconnect timeout in milliseconds (default: 5 seconds) */
  reconnectTimeoutMs: parseInt(process.env["RECONNECT_TIMEOUT_MS"] ?? "5000", 10),

  /** Cleanup interval in milliseconds (default: 5 minutes) */
  cleanupIntervalMs: parseInt(process.env["CLEANUP_INTERVAL_MS"] ?? "300000", 10),
} as const;
