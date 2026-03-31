import { stat, readdir, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProfileInfo, ControllerError } from "@moat-browser/types";
import { config, frozenPath, livePath } from "./config.js";

const execFileAsync = promisify(execFile);

export async function cowCopyProfile(
  profileName: string,
  agentId: string
): Promise<string | ControllerError> {
  const src = frozenPath(profileName);
  const dst = livePath(agentId);

  try {
    await stat(src);
  } catch {
    return { _tag: "ProfileNotFound", profileName };
  }

  // Check frozen metadata
  try {
    const metaPath = `${src}/.moat-frozen`;
    await stat(metaPath);
  } catch {
    return { _tag: "ProfileNotFrozen", profileName };
  }

  try {
    await mkdir(dst, { recursive: true });
    await execFileAsync("cp", ["--reflink=auto", "-a", `${src}/.`, dst]);
    // Remove frozen marker from live copy
    await rm(`${dst}/.moat-frozen`, { force: true });
    return dst;
  } catch (err) {
    return { _tag: "ProfileCopyFailed", reason: String(err) };
  }
}

export async function freezeProfile(
  profileName: string
): Promise<{ snapshotId: string; frozenAt: string } | ControllerError> {
  const liveSrc = livePath(profileName);
  const frozenDst = frozenPath(profileName);

  try {
    await stat(liveSrc);
  } catch {
    return { _tag: "ProfileNotFound", profileName };
  }

  try {
    // Move live → frozen (atomic on same filesystem)
    await mkdir(`${config.profilesBase}/${config.frozenDir}`, { recursive: true });
    await execFileAsync("mv", [liveSrc, frozenDst]);

    // Write frozen metadata
    const frozenAt = new Date().toISOString();
    const snapshotId = `${profileName}-${Date.now()}`;
    await writeFile(
      `${frozenDst}/.moat-frozen`,
      JSON.stringify({ snapshotId, frozenAt, profileName }),
    );

    return { snapshotId, frozenAt };
  } catch (err) {
    return { _tag: "ProfileCopyFailed", reason: String(err) };
  }
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const profiles: ProfileInfo[] = [];

  for (const [dir, frozen] of [
    [`${config.profilesBase}/${config.frozenDir}`, true],
    [`${config.profilesBase}/${config.liveDir}`, false],
  ] as const) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = `${dir}/${entry.name}`;
        const info: ProfileInfo = {
          name: entry.name,
          frozen,
          sizeBytes: 0, // Would need du for accurate size
        };

        if (frozen) {
          try {
            const meta = JSON.parse(
              await readFile(`${fullPath}/.moat-frozen`, "utf-8"),
            );
            (info as { frozenAt?: string }).frozenAt = meta.frozenAt;
          } catch {
            // No metadata
          }
        }

        profiles.push(info);
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return profiles;
}

export async function deleteProfile(
  profileName: string
): Promise<true | ControllerError> {
  const frozen = frozenPath(profileName);
  const live = livePath(profileName);

  let found = false;
  try {
    await stat(frozen);
    await rm(frozen, { recursive: true, force: true });
    found = true;
  } catch {
    // Not in frozen
  }

  try {
    await stat(live);
    await rm(live, { recursive: true, force: true });
    found = true;
  } catch {
    // Not in live
  }

  if (!found) {
    return { _tag: "ProfileNotFound", profileName };
  }
  return true;
}

export async function cleanOrphanProfiles(
  activeAgentIds: Set<string>
): Promise<string[]> {
  const cleaned: string[] = [];
  const liveDir = `${config.profilesBase}/${config.liveDir}`;

  try {
    const entries = await readdir(liveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!activeAgentIds.has(entry.name)) {
        await rm(`${liveDir}/${entry.name}`, { recursive: true, force: true });
        cleaned.push(entry.name);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return cleaned;
}
