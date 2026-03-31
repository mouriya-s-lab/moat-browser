export interface ShimConfig {
  readonly gateway: string;
  readonly token: string;
  readonly agentId: string;
  readonly profile: string;
  readonly instance?: string;
}

export function configFromEnv(): ShimConfig {
  const gateway = process.env["MOAT_BROWSER_GATEWAY"];
  const token = process.env["MOAT_BROWSER_TOKEN"];
  const agentId = process.env["MOAT_BROWSER_AGENT_ID"];
  const profile = process.env["MOAT_BROWSER_PROFILE"];
  const instance = process.env["MOAT_BROWSER_INSTANCE"];

  if (!gateway || !token || !agentId || !profile) {
    throw new Error(
      "Missing required env vars: MOAT_BROWSER_GATEWAY, MOAT_BROWSER_TOKEN, MOAT_BROWSER_AGENT_ID, MOAT_BROWSER_PROFILE"
    );
  }

  const result: ShimConfig = { gateway, token, agentId, profile };
  if (instance) {
    return { ...result, instance };
  }
  return result;
}
