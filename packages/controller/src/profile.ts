import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Config } from "./config";

type ProfileError = { readonly _tag: "ProfileError"; readonly message: string };

const FROZEN_MARKER = ".frozen";

function frozenPath(config: Config): string {
  return path.join(config.profileSourceDir, FROZEN_MARKER);
}

export async function isProfileFrozen(config: Config): Promise<boolean> {
  try {
    await fs.access(frozenPath(config));
    return true;
  } catch {
    return false;
  }
}

export async function freezeProfile(
  config: Config
): Promise<void | ProfileError> {
  try {
    await fs.access(config.profileSourceDir);
  } catch {
    return {
      _tag: "ProfileError",
      message: `Profile source directory does not exist: ${config.profileSourceDir}`,
    };
  }

  if (await isProfileFrozen(config)) {
    return {
      _tag: "ProfileError",
      message: "Profile is already frozen",
    };
  }

  try {
    await fs.writeFile(frozenPath(config), new Date().toISOString(), "utf-8");
  } catch (err) {
    return {
      _tag: "ProfileError",
      message: `Failed to freeze profile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function unfreezeProfile(
  config: Config
): Promise<void | ProfileError> {
  if (!(await isProfileFrozen(config))) {
    return {
      _tag: "ProfileError",
      message: "Profile is not frozen",
    };
  }

  try {
    await fs.unlink(frozenPath(config));
  } catch (err) {
    return {
      _tag: "ProfileError",
      message: `Failed to unfreeze profile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function copyProfile(
  config: Config,
  agentId: string
): Promise<void | ProfileError> {
  if (!(await isProfileFrozen(config))) {
    return {
      _tag: "ProfileError",
      message: "Cannot copy profile: profile is not frozen",
    };
  }

  const targetDir = path.join(config.profilesDir, `agent-${agentId}`);

  try {
    await fs.mkdir(config.profilesDir, { recursive: true });
    await fs.cp(config.profileSourceDir, targetDir, { recursive: true });
    // Remove the .frozen marker from the copy — agent profile should be writable
    const copiedMarker = path.join(targetDir, FROZEN_MARKER);
    await fs.unlink(copiedMarker).catch(() => {});
    // Remove Chrome lock files — stale locks from the source prevent Chrome from starting
    for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await fs.unlink(path.join(targetDir, lockFile)).catch(() => {});
    }
    execSync(`chown -R 1000:1000 ${targetDir}`);
  } catch (err) {
    return {
      _tag: "ProfileError",
      message: `Failed to copy profile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function cleanupProfile(
  config: Config,
  agentId: string
): Promise<void | ProfileError> {
  const targetDir = path.join(config.profilesDir, `agent-${agentId}`);

  try {
    await fs.rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    return {
      _tag: "ProfileError",
      message: `Failed to cleanup profile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
