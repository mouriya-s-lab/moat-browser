/**
 * config.ts — Environment variable configuration for the Shim
 */

export const config = {
  /** Gateway URL (Socket.IO server) */
  gateway: process.env["MOAT_BROWSER_GATEWAY"] ?? "http://localhost:9900",

  /** JWT token for authentication */
  token: process.env["MOAT_BROWSER_TOKEN"] ?? "",

  /** Agent ID */
  agentId: process.env["MOAT_BROWSER_AGENT_ID"] ?? "",

  /** Unix socket path for daemon mode */
  socket: process.env["MOAT_BROWSER_SOCKET"] ?? "/run/agent-browser/main.sock",
} as const;
