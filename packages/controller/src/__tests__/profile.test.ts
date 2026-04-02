import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Config } from "../config";
import {
  freezeProfile,
  unfreezeProfile,
  isProfileFrozen,
  copyProfile,
  cleanupProfile,
} from "../profile";

function makeConfig(baseDir: string): Config {
  return {
    port: 3000,
    jwtSecret: "test-secret",
    dockerSocket: "/var/run/docker.sock",
    profileSourceDir: path.join(baseDir, "profile"),
    profilesDir: path.join(baseDir, "profiles"),
    agentChromeImage: "moat-agent-chrome",
    idleTimeoutMs: 300000,
    reconnectTimeoutMs: 5000,
  };
}

describe("profile management", () => {
  let baseDir: string;
  let config: Config;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "moat-profile-test-"));
    config = makeConfig(baseDir);
    await fs.mkdir(config.profileSourceDir, { recursive: true });
    // Seed with some dummy profile files
    await fs.writeFile(
      path.join(config.profileSourceDir, "Cookies"),
      "cookie-data"
    );
    await fs.mkdir(path.join(config.profileSourceDir, "Local Storage"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(config.profileSourceDir, "Local Storage", "leveldb"),
      "storage-data"
    );
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe("freezeProfile", () => {
    test("creates .frozen marker in profile source directory", async () => {
      const result = await freezeProfile(config);
      expect(result).toBeUndefined();

      const frozenExists = await fs
        .access(path.join(config.profileSourceDir, ".frozen"))
        .then(() => true)
        .catch(() => false);
      expect(frozenExists).toBe(true);
    });

    test("returns error if profile is already frozen", async () => {
      await freezeProfile(config);
      const result = await freezeProfile(config);
      expect(result).toEqual({
        _tag: "ProfileError",
        message: "Profile is already frozen",
      });
    });

    test("returns error if profile source dir does not exist", async () => {
      const badConfig = makeConfig(path.join(baseDir, "nonexistent"));
      const result = await freezeProfile(badConfig);
      expect(result).toBeDefined();
      expect(result!._tag).toBe("ProfileError");
      expect(result!.message).toContain("does not exist");
    });
  });

  describe("unfreezeProfile", () => {
    test("removes .frozen marker", async () => {
      await freezeProfile(config);
      const result = await unfreezeProfile(config);
      expect(result).toBeUndefined();

      const frozenExists = await fs
        .access(path.join(config.profileSourceDir, ".frozen"))
        .then(() => true)
        .catch(() => false);
      expect(frozenExists).toBe(false);
    });

    test("returns error if profile is not frozen", async () => {
      const result = await unfreezeProfile(config);
      expect(result).toEqual({
        _tag: "ProfileError",
        message: "Profile is not frozen",
      });
    });
  });

  describe("isProfileFrozen", () => {
    test("returns false when not frozen", async () => {
      expect(await isProfileFrozen(config)).toBe(false);
    });

    test("returns true when frozen", async () => {
      await freezeProfile(config);
      expect(await isProfileFrozen(config)).toBe(true);
    });
  });

  describe("copyProfile", () => {
    test("copies profile to agent directory when frozen", async () => {
      await freezeProfile(config);
      const result = await copyProfile(config, "agent-1");
      expect(result).toBeUndefined();

      const targetDir = path.join(config.profilesDir, "agent-agent-1");
      const cookies = await fs.readFile(
        path.join(targetDir, "Cookies"),
        "utf-8"
      );
      expect(cookies).toBe("cookie-data");

      const storage = await fs.readFile(
        path.join(targetDir, "Local Storage", "leveldb"),
        "utf-8"
      );
      expect(storage).toBe("storage-data");
    });

    test("removes .frozen marker from copy", async () => {
      await freezeProfile(config);
      await copyProfile(config, "agent-1");

      const targetDir = path.join(config.profilesDir, "agent-agent-1");
      const frozenExists = await fs
        .access(path.join(targetDir, ".frozen"))
        .then(() => true)
        .catch(() => false);
      expect(frozenExists).toBe(false);
    });

    test("returns error if profile is not frozen", async () => {
      const result = await copyProfile(config, "agent-1");
      expect(result).toEqual({
        _tag: "ProfileError",
        message: "Cannot copy profile: profile is not frozen",
      });
    });

    test("creates independent copies for multiple agents", async () => {
      await freezeProfile(config);
      await copyProfile(config, "agent-1");
      await copyProfile(config, "agent-2");

      const dir1 = path.join(config.profilesDir, "agent-agent-1");
      const dir2 = path.join(config.profilesDir, "agent-agent-2");

      const exists1 = await fs
        .access(dir1)
        .then(() => true)
        .catch(() => false);
      const exists2 = await fs
        .access(dir2)
        .then(() => true)
        .catch(() => false);
      expect(exists1).toBe(true);
      expect(exists2).toBe(true);
    });
  });

  describe("cleanupProfile", () => {
    test("removes agent profile directory", async () => {
      await freezeProfile(config);
      await copyProfile(config, "agent-1");

      const targetDir = path.join(config.profilesDir, "agent-agent-1");
      const existsBefore = await fs
        .access(targetDir)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(true);

      const result = await cleanupProfile(config, "agent-1");
      expect(result).toBeUndefined();

      const existsAfter = await fs
        .access(targetDir)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(false);
    });

    test("succeeds even if directory does not exist", async () => {
      const result = await cleanupProfile(config, "nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("full lifecycle", () => {
    test("freeze → copy → cleanup → unfreeze → re-freeze → copy", async () => {
      // Freeze
      expect(await freezeProfile(config)).toBeUndefined();
      expect(await isProfileFrozen(config)).toBe(true);

      // Copy
      expect(await copyProfile(config, "agent-1")).toBeUndefined();
      const dir1 = path.join(config.profilesDir, "agent-agent-1");
      const exists1 = await fs
        .access(dir1)
        .then(() => true)
        .catch(() => false);
      expect(exists1).toBe(true);

      // Cleanup
      expect(await cleanupProfile(config, "agent-1")).toBeUndefined();
      const existsAfter = await fs
        .access(dir1)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(false);

      // Unfreeze
      expect(await unfreezeProfile(config)).toBeUndefined();
      expect(await isProfileFrozen(config)).toBe(false);

      // Write something new (simulating human re-login)
      await fs.writeFile(
        path.join(config.profileSourceDir, "NewCookie"),
        "new-cookie-data"
      );

      // Re-freeze
      expect(await freezeProfile(config)).toBeUndefined();
      expect(await isProfileFrozen(config)).toBe(true);

      // Second copy should include new data
      expect(await copyProfile(config, "agent-2")).toBeUndefined();
      const dir2 = path.join(config.profilesDir, "agent-agent-2");
      const newCookie = await fs.readFile(
        path.join(dir2, "NewCookie"),
        "utf-8"
      );
      expect(newCookie).toBe("new-cookie-data");
    });
  });
});
