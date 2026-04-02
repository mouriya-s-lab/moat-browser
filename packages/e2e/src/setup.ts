import { TEST_CONFIG, waitForPort } from "./helpers";

export async function ensureEnvironment(): Promise<void> {
  const url = new URL(TEST_CONFIG.controllerUrl);
  const host = url.hostname;
  const port = parseInt(url.port || "3000", 10);

  const ready = await waitForPort(host, port, { timeoutMs: 60000 });
  if (!ready) {
    throw new Error(
      `Controller not reachable at ${host}:${port}. ` +
        "Start the compose environment first: " +
        "docker compose -f packages/e2e/docker-compose.test.yml up -d"
    );
  }
}
