export const config = {
  get profilesBase() { return process.env["MOAT_PROFILES_BASE"] ?? "/data/profiles"; },
  frozenDir: "frozen",
  liveDir: "live",

  get agentChromeImage() { return process.env["MOAT_AGENT_CHROME_IMAGE"] ?? "moat-browser/agent-chrome:latest"; },
  get userChromeImage() { return process.env["MOAT_USER_CHROME_IMAGE"] ?? "moat-browser/user-chrome:latest"; },

  containerPrefix: "mb-",
  userChromeContainerName: "mb-user-chrome",

  agentMemoryLimit: 1024 * 1024 * 1024, // 1GB
  agentCpuQuota: 100_000, // 1 core
  agentShmSize: 256 * 1024 * 1024, // 256MB

  nekoPortRangeStart: 9080,
  nekoPortRangeEnd: 9099,

  get socketDir() { return process.env["MOAT_SOCKET_DIR"] ?? "/run/moat-browser"; },
  controllerSocket: "controller.sock",

  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
  containerTimeoutMs: 60 * 60 * 1000, // 1 hour
};

export function frozenPath(profileName: string): string {
  return `${config.profilesBase}/${config.frozenDir}/${profileName}`;
}

export function livePath(profileName: string): string {
  return `${config.profilesBase}/${config.liveDir}/${profileName}`;
}
