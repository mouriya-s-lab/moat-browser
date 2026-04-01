/**
 * cleanup.ts — Periodic cleanup of expired sessions and orphaned profiles
 *
 * Runs every CLEANUP_INTERVAL_MS (default: 5 minutes).
 * - Expires stale sessions (idle timeout, reconnect timeout)
 * - Destroys containers for expired sessions
 * - Removes orphaned agent profile directories
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { config } from "./config.js";
import type { ControllerServer } from "./socketio.js";

// ---------------------------------------------------------------------------
// Cleanup scheduler
// ---------------------------------------------------------------------------

export class CleanupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly server: ControllerServer) {}

  /** Start periodic cleanup. */
  start(intervalMs: number = config.cleanupIntervalMs): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this._run(), intervalMs);
    console.log(`[cleanup] scheduler started (interval: ${intervalMs}ms)`);
  }

  /** Stop periodic cleanup. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[cleanup] scheduler stopped");
    }
  }

  /** Run cleanup immediately. */
  async runNow(): Promise<void> {
    return this._run();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _run(): Promise<void> {
    const now = Date.now();
    const registry = this.server.getRegistry();

    // Find stale sessions
    const stale = registry.stale(now);
    if (stale.length > 0) {
      console.log(`[cleanup] found ${stale.length} stale session(s)`);
    }

    for (const { sessionId, state } of stale) {
      console.log(`[cleanup] cleaning up session ${sessionId} (state: ${state._tag})`);
      await this.server._cleanupSession(sessionId).catch((e) => {
        console.error(`[cleanup] error cleaning session ${sessionId}: ${String(e)}`);
      });
    }

    // Remove orphaned agent profile directories
    await this._cleanupOrphanedProfiles(registry).catch((e) => {
      console.error(`[cleanup] orphan profile cleanup failed: ${String(e)}`);
    });
  }

  private async _cleanupOrphanedProfiles(
    registry: ReturnType<ControllerServer["getRegistry"]>
  ): Promise<void> {
    const agentsDir = config.profileAgentsDir;
    if (!existsSync(agentsDir)) return;

    let entries: string[];
    try {
      entries = await readdir(agentsDir);
    } catch {
      return;
    }

    // Active sessions — collect all profile paths
    const activePaths = new Set<string>();
    for (const [, state] of registry.all()) {
      if ("profilePath" in state) {
        activePaths.add((state as { profilePath: string }).profilePath);
      }
    }

    const { rm } = await import("fs/promises");
    for (const entry of entries) {
      const fullPath = `${agentsDir}/${entry}`;
      if (!activePaths.has(fullPath)) {
        console.log(`[cleanup] removing orphaned profile: ${fullPath}`);
        await rm(fullPath, { recursive: true, force: true }).catch((e) => {
          console.error(`[cleanup] failed to remove ${fullPath}: ${String(e)}`);
        });
      }
    }
  }
}
