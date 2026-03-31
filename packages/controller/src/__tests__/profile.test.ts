import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cowCopyProfile,
  freezeProfile,
  listProfiles,
  deleteProfile,
  cleanOrphanProfiles,
} from "../profile.js";

describe("profile operations", () => {
  let testDir: string;
  let frozenDir: string;
  let liveDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "moat-test-"));
    frozenDir = join(testDir, "frozen");
    liveDir = join(testDir, "live");
    await mkdir(frozenDir, { recursive: true });
    await mkdir(liveDir, { recursive: true });

    // Config uses getters that read env at call time
    process.env["MOAT_PROFILES_BASE"] = testDir;
  });

  afterEach(async () => {
    delete process.env["MOAT_PROFILES_BASE"];
    await rm(testDir, { recursive: true, force: true });
  });

  test("cowCopyProfile copies frozen profile to live", async () => {
    const profileDir = join(frozenDir, "test-profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, ".moat-frozen"), JSON.stringify({ snapshotId: "test", frozenAt: "2026-01-01" }));
    await writeFile(join(profileDir, "Cookies"), "test-cookies");

    const result = await cowCopyProfile("test-profile", "agent-01");

    expect(typeof result).toBe("string");
    const dst = result as string;

    // Verify copy
    const cookies = await readFile(join(dst, "Cookies"), "utf-8");
    expect(cookies).toBe("test-cookies");

    // Verify .moat-frozen removed from live
    try {
      await stat(join(dst, ".moat-frozen"));
      expect(true).toBe(false);
    } catch {
      // Expected
    }
  });

  test("cowCopyProfile returns ProfileNotFound for missing profile", async () => {
    const result = await cowCopyProfile("nonexistent", "agent-01");
    expect(result).toEqual({ _tag: "ProfileNotFound", profileName: "nonexistent" });
  });

  test("cowCopyProfile returns ProfileNotFrozen for unfrozen profile", async () => {
    await mkdir(join(frozenDir, "not-frozen"), { recursive: true });

    const result = await cowCopyProfile("not-frozen", "agent-01");
    expect(result).toEqual({ _tag: "ProfileNotFrozen", profileName: "not-frozen" });
  });

  test("freezeProfile moves live to frozen with metadata", async () => {
    const liveProfile = join(liveDir, "to-freeze");
    await mkdir(join(liveProfile, "Default"), { recursive: true });
    await writeFile(join(liveProfile, "Local State"), "{}");
    await writeFile(join(liveProfile, "Default/Cookies"), "data");

    const result = await freezeProfile("to-freeze");
    expect(typeof result).toBe("object");
    expect("snapshotId" in (result as object)).toBe(true);
    expect("frozenAt" in (result as object)).toBe(true);

    // Verify moved to frozen
    const frozenProfile = join(frozenDir, "to-freeze");
    const cookies = await readFile(join(frozenProfile, "Default/Cookies"), "utf-8");
    expect(cookies).toBe("data");

    // Verify .frozen.json metadata exists
    const meta = JSON.parse(await readFile(join(frozenProfile, ".frozen.json"), "utf-8"));
    expect(meta.profileName).toBe("to-freeze");

    // Verify live is gone
    try {
      await stat(liveProfile);
      expect(true).toBe(false);
    } catch {
      // Expected
    }
  });

  test("listProfiles returns profiles from both dirs", async () => {
    const fp = join(frozenDir, "frozen-1");
    await mkdir(fp);
    await writeFile(join(fp, ".moat-frozen"), JSON.stringify({ frozenAt: "2026-01-01" }));

    await mkdir(join(liveDir, "live-1"));

    const profiles = await listProfiles();
    expect(profiles.length).toBe(2);

    const frozen = profiles.find((p) => p.name === "frozen-1");
    const live = profiles.find((p) => p.name === "live-1");
    expect(frozen?.frozen).toBe(true);
    expect(frozen?.frozenAt).toBe("2026-01-01");
    expect(live?.frozen).toBe(false);
  });

  test("deleteProfile removes existing profile", async () => {
    const fp = join(frozenDir, "to-delete");
    await mkdir(fp);
    await writeFile(join(fp, "data"), "test");

    const result = await deleteProfile("to-delete");
    expect(result).toBe(true);

    try {
      await stat(fp);
      expect(true).toBe(false);
    } catch {
      // Expected — deleted
    }
  });

  test("deleteProfile returns ProfileNotFound for missing", async () => {
    const result = await deleteProfile("nonexistent");
    expect(result).toEqual({ _tag: "ProfileNotFound", profileName: "nonexistent" });
  });

  test("cleanOrphanProfiles removes profiles not in active set", async () => {
    await mkdir(join(liveDir, "active-agent"));
    await mkdir(join(liveDir, "orphan-agent"));

    const cleaned = await cleanOrphanProfiles(new Set(["active-agent"]));
    expect(cleaned).toEqual(["orphan-agent"]);

    const remaining = await readdir(liveDir);
    expect(remaining).toEqual(["active-agent"]);
  });
});
