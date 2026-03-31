import { getTimedOutAgents, destroyAgentContainer, listAgentContainers } from "./docker.js";
import { cleanOrphanProfiles, cleanOldArchives } from "./profile.js";
import { config } from "./config.js";

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanup(): void {
  cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);
  console.log(`cleanup scheduler started (every ${config.cleanupIntervalMs / 1000}s)`);
}

export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

async function runCleanup(): Promise<void> {
  try {
    // 1. Destroy timed-out containers
    const timedOut = getTimedOutAgents(config.containerTimeoutMs);
    for (const agentId of timedOut) {
      console.log(`cleanup: destroying timed-out agent ${agentId}`);
      await destroyAgentContainer(agentId);
    }

    // 2. Clean orphan live profiles
    const activeContainers = await listAgentContainers();
    const activeIds = new Set(activeContainers.map((c) => c.agentId));
    const cleaned = await cleanOrphanProfiles(activeIds);
    if (cleaned.length > 0) {
      console.log(`cleanup: removed orphan profiles: ${cleaned.join(", ")}`);
    }

    // 3. Clean old archives (>7 days)
    const archivedCleaned = await cleanOldArchives(7);
    if (archivedCleaned.length > 0) {
      console.log(`cleanup: removed old archives: ${archivedCleaned.join(", ")}`);
    }
  } catch (err) {
    console.error("cleanup error:", err);
  }
}
