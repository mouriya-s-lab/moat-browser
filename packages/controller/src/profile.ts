import { stat, readdir, rm, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ProfileInfo, type ControllerError, type FrozenMeta, FrozenMetaSchema } from "@moat-browser/types";
import { config, frozenPath, livePath, archivePath } from "./config.js";

const execFileAsync = promisify(execFile);

// ---- COW Copy ----

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
  const meta = await readFrozenMeta(src);
  if (!meta) {
    return { _tag: "ProfileNotFrozen", profileName };
  }

  try {
    await mkdir(dst, { recursive: true });
    await execFileAsync("cp", ["--reflink=auto", "-a", `${src}/.`, dst]);
    // Remove frozen marker from live copy
    await rm(`${dst}/.frozen.json`, { force: true });
    await rm(`${dst}/.moat-frozen`, { force: true });
    return dst;
  } catch (err) {
    return { _tag: "ProfileCopyFailed", reason: String(err) };
  }
}

// ---- Freeze ----

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

  // Integrity check
  const integrity = await checkProfileIntegrity(liveSrc);
  if (integrity) {
    return { _tag: "ProfileCopyFailed", reason: `Integrity check failed: ${integrity}` };
  }

  try {
    // Archive existing frozen version if present
    try {
      await stat(frozenDst);
      await archiveProfile(profileName);
    } catch {
      // No existing frozen version
    }

    // Ensure frozen directory exists
    await mkdir(`${config.profilesBase}/${config.frozenDir}`, { recursive: true });

    // Move live → frozen
    await execFileAsync("mv", [liveSrc, frozenDst]);

    // Write frozen metadata
    const frozenAt = new Date().toISOString();
    const snapshotId = `${profileName}-${Date.now()}`;
    const meta: FrozenMeta = {
      profileName,
      frozenAt,
      frozenBy: "controller",
      chromiumVersion: await detectChromiumVersion(frozenDst),
      sizeBytes: await getDirectorySize(frozenDst),
    };

    await writeFile(`${frozenDst}/.frozen.json`, JSON.stringify(meta, null, 2));

    // Make frozen directory read-only
    await execFileAsync("chmod", ["-R", "a-w", frozenDst]).catch(() => {});
    // But keep .frozen.json writable for updates
    await chmod(`${frozenDst}/.frozen.json`, 0o644).catch(() => {});

    return { snapshotId, frozenAt };
  } catch (err) {
    return { _tag: "ProfileCopyFailed", reason: String(err) };
  }
}

// ---- Archive ----

async function archiveProfile(profileName: string): Promise<void> {
  const src = frozenPath(profileName);
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const dst = archivePath(`${profileName}_${ts}`);

  await mkdir(`${config.profilesBase}/${config.archiveDir}`, { recursive: true });
  // Restore write permission before moving
  await execFileAsync("chmod", ["-R", "u+w", src]).catch(() => {});
  await execFileAsync("mv", [src, dst]);
}

export async function cleanOldArchives(maxAgeDays: number = 7): Promise<string[]> {
  const cleaned: string[] = [];
  const dir = `${config.profilesBase}/${config.archiveDir}`;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = `${dir}/${entry.name}`;
      const s = await stat(fullPath);
      if (s.mtimeMs < cutoff) {
        await rm(fullPath, { recursive: true, force: true });
        cleaned.push(entry.name);
      }
    }
  } catch {
    // Archive directory doesn't exist
  }

  return cleaned;
}

// ---- Integrity Check ----

async function checkProfileIntegrity(profilePath: string): Promise<string | null> {
  // Check Local State file exists
  try {
    await stat(`${profilePath}/Local State`);
  } catch {
    return "Missing Local State file";
  }

  // Check Default directory exists
  try {
    await stat(`${profilePath}/Default`);
  } catch {
    return "Missing Default directory";
  }

  return null; // OK
}

// ---- Version Detection ----

async function detectChromiumVersion(profilePath: string): Promise<string> {
  try {
    const localState = JSON.parse(await readFile(`${profilePath}/Local State`, "utf-8"));
    // Chromium stores version info in Local State
    const version = localState?.os_crypt?.audit_enabled !== undefined
      ? "unknown" // Can't easily extract version from Local State alone
      : "unknown";

    // Try to extract from Last Version file if exists
    try {
      const lastVersion = await readFile(`${profilePath}/Last Version`, "utf-8");
      return lastVersion.trim() || version;
    } catch {
      return version;
    }
  } catch {
    return "unknown";
  }
}

// ---- List ----

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
          sizeBytes: 0,
        };

        if (frozen) {
          const meta = await readFrozenMeta(fullPath);
          if (meta) {
            (info as { frozenAt?: string }).frozenAt = meta.frozenAt;
            (info as { chromiumVersion?: string }).chromiumVersion = meta.chromiumVersion;
            (info as { sizeBytes: number }).sizeBytes = meta.sizeBytes;
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

// ---- Delete ----

export async function deleteProfile(
  profileName: string
): Promise<true | ControllerError> {
  const frozen = frozenPath(profileName);
  const live = livePath(profileName);

  let found = false;
  try {
    await stat(frozen);
    // Restore write permission before deleting
    await execFileAsync("chmod", ["-R", "u+w", frozen]).catch(() => {});
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

// ---- Orphan Cleanup ----

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

// ---- Helpers ----

async function readFrozenMeta(profilePath: string): Promise<FrozenMeta | null> {
  // Try new format first, then legacy
  for (const filename of [".frozen.json", ".moat-frozen"]) {
    try {
      const raw = JSON.parse(await readFile(`${profilePath}/${filename}`, "utf-8"));
      const validated = FrozenMetaSchema(raw);
      if (!(validated instanceof Array)) {
        return validated as FrozenMeta;
      }
      // If validation fails, return raw data with defaults
      return {
        profileName: raw.profileName ?? "unknown",
        frozenAt: raw.frozenAt ?? "unknown",
        frozenBy: raw.frozenBy ?? "unknown",
        chromiumVersion: raw.chromiumVersion ?? "unknown",
        sizeBytes: raw.sizeBytes ?? 0,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function getDirectorySize(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", path]);
    return parseInt(stdout.split("\t")[0] ?? "0", 10);
  } catch {
    return 0;
  }
}

// ---- Chromium Version Check ----

export async function checkChromiumVersion(
  profileName: string,
  currentVersion: string
): Promise<ControllerError | null> {
  const src = frozenPath(profileName);
  const meta = await readFrozenMeta(src);
  if (!meta) return null; // No metadata, skip check

  if (meta.chromiumVersion !== "unknown" &&
      currentVersion !== "unknown" &&
      meta.chromiumVersion !== currentVersion) {
    return {
      _tag: "ChromiumVersionMismatch",
      expected: meta.chromiumVersion,
      actual: currentVersion,
    };
  }

  return null;
}
