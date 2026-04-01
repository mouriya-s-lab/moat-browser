// Shim environment variable configuration (design.md §8 Shim SDK)
export interface ShimConfig {
  readonly gateway: string;    // MOAT_BROWSER_GATEWAY — Controller Socket.IO URL
  readonly token: string;      // MOAT_BROWSER_TOKEN — JWT Token
  readonly agentId: string;    // MOAT_BROWSER_AGENT_ID — Agent ID
  readonly socketPath: string; // MOAT_BROWSER_SOCKET — Daemon Unix socket path
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function loadConfig(): ShimConfig {
  return {
    gateway: requireEnv("MOAT_BROWSER_GATEWAY"),
    token: requireEnv("MOAT_BROWSER_TOKEN"),
    agentId: requireEnv("MOAT_BROWSER_AGENT_ID"),
    socketPath:
      process.env["MOAT_BROWSER_SOCKET"] ?? "/run/agent-browser/main.sock",
  };
}
