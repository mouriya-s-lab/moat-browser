import { describe, test, expect } from "bun:test";
import { validateProfileAction, FrozenMetaSchema } from "../profile.js";
import type { ProfileState, ProfileAction } from "../profile.js";

describe("validateProfileAction", () => {
  const empty: ProfileState = { _tag: "Empty", name: "test" };
  const inUse: ProfileState = { _tag: "InUse", name: "test", containerId: "abc" };
  const frozen: ProfileState = {
    _tag: "Frozen",
    name: "test",
    meta: { profileName: "test", frozenAt: "2026-01-01", frozenBy: "user", chromiumVersion: "146", sizeBytes: 100 },
  };
  const archived: ProfileState = { _tag: "Archived", name: "test", archivedAt: "2026-01-01" };

  // Freeze action
  test("Freeze from InUse → allowed", () => {
    expect(validateProfileAction(inUse, { _tag: "Freeze", name: "test" })).toBeNull();
  });

  test("Freeze from Empty → NotFound", () => {
    const r = validateProfileAction(empty, { _tag: "Freeze", name: "test" });
    expect(r?._tag).toBe("NotFound");
  });

  test("Freeze from Frozen → AlreadyFrozen", () => {
    const r = validateProfileAction(frozen, { _tag: "Freeze", name: "test" });
    expect(r?._tag).toBe("AlreadyFrozen");
  });

  // CopyForAgent action
  test("CopyForAgent from Frozen → allowed", () => {
    expect(validateProfileAction(frozen, { _tag: "CopyForAgent", name: "test", agentId: "a1" })).toBeNull();
  });

  test("CopyForAgent from InUse → NotFrozen", () => {
    const r = validateProfileAction(inUse, { _tag: "CopyForAgent", name: "test", agentId: "a1" });
    expect(r?._tag).toBe("NotFrozen");
  });

  test("CopyForAgent from Empty → NotFound", () => {
    const r = validateProfileAction(empty, { _tag: "CopyForAgent", name: "test", agentId: "a1" });
    expect(r?._tag).toBe("NotFound");
  });

  // Delete action
  test("Delete from Frozen → allowed", () => {
    expect(validateProfileAction(frozen, { _tag: "Delete", name: "test" })).toBeNull();
  });

  test("Delete from InUse → StillInUse", () => {
    const r = validateProfileAction(inUse, { _tag: "Delete", name: "test" });
    expect(r?._tag).toBe("StillInUse");
  });

  test("Delete from Empty → NotFound", () => {
    const r = validateProfileAction(empty, { _tag: "Delete", name: "test" });
    expect(r?._tag).toBe("NotFound");
  });

  // Archive action
  test("Archive from Frozen → allowed", () => {
    expect(validateProfileAction(frozen, { _tag: "Archive", name: "test" })).toBeNull();
  });

  test("Archive from InUse → StillInUse", () => {
    const r = validateProfileAction(inUse, { _tag: "Archive", name: "test" });
    expect(r?._tag).toBe("StillInUse");
  });

  // Create action
  test("Create always allowed", () => {
    expect(validateProfileAction(empty, { _tag: "Create", name: "new" })).toBeNull();
    expect(validateProfileAction(frozen, { _tag: "Create", name: "new" })).toBeNull();
  });

  // CleanLive action
  test("CleanLive always allowed", () => {
    expect(validateProfileAction(empty, { _tag: "CleanLive", agentId: "a1" })).toBeNull();
    expect(validateProfileAction(inUse, { _tag: "CleanLive", agentId: "a1" })).toBeNull();
  });

  // Thaw action
  test("Thaw from Frozen → allowed", () => {
    expect(validateProfileAction(frozen, { _tag: "Thaw", name: "test" })).toBeNull();
  });

  test("Thaw from Archived → NotFound", () => {
    const r = validateProfileAction(archived, { _tag: "Thaw", name: "test" });
    expect(r?._tag).toBe("NotFound");
  });
});

describe("FrozenMetaSchema", () => {
  test("accepts valid metadata", () => {
    const r = FrozenMetaSchema({
      profileName: "corp-sf",
      frozenAt: "2026-01-01T00:00:00Z",
      frozenBy: "controller",
      chromiumVersion: "146.0.7680.164",
      sizeBytes: 1024,
    });
    expect(r instanceof Array).toBe(false);
  });

  test("accepts with optional fields", () => {
    const r = FrozenMetaSchema({
      profileName: "corp-sf",
      frozenAt: "2026-01-01T00:00:00Z",
      frozenBy: "controller",
      chromiumVersion: "146",
      sizeBytes: 0,
      domainsLoggedIn: ["example.com", "google.com"],
      checksum: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    expect(r instanceof Array).toBe(false);
  });

  test("rejects invalid checksum", () => {
    const r = FrozenMetaSchema({
      profileName: "test",
      frozenAt: "2026-01-01",
      frozenBy: "user",
      chromiumVersion: "146",
      sizeBytes: 0,
      checksum: "bad-checksum",
    });
    expect(r instanceof Array).toBe(true);
  });

  test("rejects negative sizeBytes", () => {
    const r = FrozenMetaSchema({
      profileName: "test",
      frozenAt: "2026-01-01",
      frozenBy: "user",
      chromiumVersion: "146",
      sizeBytes: -1,
    });
    expect(r instanceof Array).toBe(true);
  });
});
