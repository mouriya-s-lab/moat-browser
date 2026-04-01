// Cleanup scheduler — periodic expired session + orphan profile cleanup (design.md §4)
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { config } from "./config.js";
import { listSessions, applyEvent, deleteSession, detachConnection } from "./session.js";
import { destroyAgentChrome, listContainers } from "./docker.js";
import { disconnect } from "./cdp-bridge.js";

// Run one cleanup pass:
// 1. Destroy Expired sessions (stop container, rm profile)
// 2. Remove orphaned agent-profile directories with no matching container
async function runCleanup(): Promise<void> {
  // --- Phase 1: Expired sessions ---
  const sessions = listSessions();

  for (const { sessionId, stateTag } of sessions) {
    if (stateTag !== "Expired") continue;

    const entry = listSessions().find((s) => s.sessionId === sessionId);
    if (!entry) continue;

    // Detach and close CDP connection if still open
    const conn = detachConnection(sessionId);
    if (conn) await disconnect(conn);

    // TODO: destroyAgentChrome requires containerId + profilePath
    // These are stored in session state in future iterations.
    // For now, signal cleanup complete and remove from registry.
    applyEvent(sessionId, { _tag: "CleanupComplete" });
    deleteSession(sessionId);
  }

  // --- Phase 2: Orphaned agent-profile directories ---
  let containerIds: Set<string>;
  try {
    const result = await listContainers("moat-browser=agent-chrome");
    if ("_tag" in result) {
      // Docker error — skip orphan cleanup this pass
      return;
    }
    containerIds = new Set(result.map((c) => c.id));
  } catch {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(config.agentProfilesDir);
  } catch {
    // Directory may not exist yet
    return;
  }

  for (const dirName of entries) {
    // Profile dirs are named {agentId}-{uuid}; check if any running container uses this dir
    // Heuristic: if no container has this agentId prefix, remove
    const agentId = dirName.split("-").slice(0, -5).join("-"); // strip UUID suffix
    const hasContainer = Array.from(containerIds).some((id) => id.startsWith(agentId.slice(0, 12)));

    if (!hasContainer) {
      const fullPath = `${config.agentProfilesDir}/${dirName}`;
      try {
        execSync(`rm -rf "${fullPath}"`, { stdio: "pipe" });
      } catch {
        // Best-effort
      }
    }
  }
}

// Start the cleanup interval; returns a function to stop it
export function startCleanup(): () => void {
  const handle = setInterval(() => {
    runCleanup().catch((err) => {
      console.error("[cleanup] error:", err);
    });
  }, config.cleanupIntervalMs);

  return () => clearInterval(handle);
}
