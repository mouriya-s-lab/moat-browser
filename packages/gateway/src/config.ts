export const config = {
  port: Number(process.env["MOAT_GATEWAY_PORT"] ?? 9800),
  get jwtSecret() { return process.env["MOAT_BROWSER_JWT_SECRET"] ?? ""; },
  get controllerSocket() { return process.env["MOAT_CONTROLLER_SOCKET"] ?? "/run/moat-browser/controller.sock"; },

  sessionTimeoutMs: 60 * 60 * 1000, // 1 hour
  disconnectGraceMs: 5_000, // 5s grace before cleanup
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for screenshots
};
