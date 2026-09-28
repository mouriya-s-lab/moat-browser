import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildCreateBody,
  createContainerManager,
  LABEL_ROLE,
  LABEL_OWNER,
  LABEL_ROLE_AGENT_CHROME,
  LABEL_SESSION_ID,
  profileDestination,
  type ContainerManagerConfig,
  type DockerFetch,
} from "./container-manager.js";

type Call = {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
};

type Route = (call: Call) => Response | Promise<Response>;

function makeFetch(routes: Route[], calls: Call[]): DockerFetch {
  return async (path, init) => {
    const method = ((init?.method as string) ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { path, method, body };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res.status !== 599) return res; // 599 = pass-through sentinel
    }
    return new Response(`no route matched ${method} ${path}`, { status: 500 });
  };
}

function match(method: string, matcher: string | RegExp, handler: (call: Call) => Response | Promise<Response>): Route {
  return async (call) => {
    if (call.method !== method) return new Response(null, { status: 599 });
    const hit = typeof matcher === "string" ? call.path === matcher : matcher.test(call.path);
    if (!hit) return new Response(null, { status: 599 });
    return handler(call);
  };
}

const baseConfig: Omit<ContainerManagerConfig, "dockerFetch"> = {
  profileSource: "/data/profile",
  profileRegistry: {},
  profileStoreRoot: "/tmp/profiles-test",
  profilesWork: "/tmp/profiles-test",
  profilesHostPath: "/data/profiles",
  dockerNetwork: "moat",
  agentChromeImage: "agent-chrome:test",
  cdpReadyTimeout: 100,
  expectedBrowserVersion: "147.0.7727.15",
  owner: "test-owner",
};

let originalWarn: typeof console.warn;
let warns: string[];

beforeEach(() => {
  warns = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

describe("buildCreateBody", () => {
  it("stamps role and session-id labels so the controller can reverse-lookup its own containers", () => {
    const body = buildCreateBody("sess-abc", {
      agentChromeImage: "agent-chrome:test",
      profilesHostPath: "/data/profiles",
      dockerNetwork: "moat",
      owner: baseConfig.owner,
    });
    const labels = (body as { Labels: Record<string, string> }).Labels;
    expect(labels[LABEL_ROLE]).toBe(LABEL_ROLE_AGENT_CHROME);
    expect(labels[LABEL_SESSION_ID]).toBe("sess-abc");
  });
});

describe("createContainerManager", () => {
  it("reap returns Ok(reaped: 0) when Docker reports no matching containers", async () => {
    const calls: Call[] = [];
    const dockerFetch = makeFetch(
      [
        match("GET", /^\/containers\/json/, () => new Response("[]", { status: 200 })),
      ],
      calls,
    );

    const cm = createContainerManager({ ...baseConfig, dockerFetch });
    const result = await cm.reap();

    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") throw new Error("unreachable");
    expect(result.value.reaped).toBe(0);

    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toContain("all=true");
    expect(decodeURIComponent(calls[0]?.path ?? "")).toContain(`${LABEL_ROLE}=${LABEL_ROLE_AGENT_CHROME}`);
  });

  it("reap stops and deletes every label-matched container", async () => {
    const calls: Call[] = [];
    const dockerFetch = makeFetch(
      [
        match(
          "GET",
          /^\/containers\/json/,
          () =>
            new Response(
              JSON.stringify([
                { Id: "orphan-a", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME, [LABEL_SESSION_ID]: "sess-a" } },
                { Id: "orphan-b", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME } },
              ]),
              { status: 200 },
            ),
        ),
        match("POST", /^\/containers\/[^/]+\/stop/, () => new Response(null, { status: 204 })),
        match("DELETE", /^\/containers\/[^/]+$/, () => new Response(null, { status: 204 })),
      ],
      calls,
    );

    const cm = createContainerManager({ ...baseConfig, dockerFetch });
    const result = await cm.reap();

    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") throw new Error("unreachable");
    expect(result.value.reaped).toBe(2);

    const stopped = calls.filter((c) => c.method === "POST" && c.path.includes("/stop"));
    const deleted = calls.filter((c) => c.method === "DELETE");
    expect(stopped.map((c) => c.path)).toEqual([
      "/containers/orphan-a/stop?t=5",
      "/containers/orphan-b/stop?t=5",
    ]);
    expect(deleted.map((c) => c.path)).toEqual(["/containers/orphan-a", "/containers/orphan-b"]);
  });

  for (const failedOperation of ["stop", "delete"] as const) {
    it(`reap propagates ${failedOperation} failure, protects its mounted copy, and clears it after Docker removal`, async () => {
      const root = await mkdtemp(join(tmpdir(), "moat-289-reap-failure-"));
      const sessionId = "aaaaaaaa-1111-4222-8333-555555555555";
      const foreignSession = "bbbbbbbb-1111-4222-8333-555555555555";
      const ownPath = profileDestination(root, baseConfig.owner, sessionId);
      const foreignPath = profileDestination(root, "foreign-owner", foreignSession);
      await mkdir(ownPath);
      await mkdir(foreignPath);
      const foreignBefore = await stat(foreignPath);
      const calls: Call[] = [];
      let failing = true;
      let present = true;
      const dockerFetch = makeFetch([
        match("GET", /^\/containers\/json/, (call) => {
          const own = { Id: "ctr-own", Labels: {
            [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME,
            [LABEL_OWNER]: baseConfig.owner,
            [LABEL_SESSION_ID]: sessionId,
          } };
          const foreign = { Id: "ctr-foreign", Labels: {
            [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME,
            [LABEL_OWNER]: "foreign-owner",
            [LABEL_SESSION_ID]: foreignSession,
          } };
          const ownerFiltered = decodeURIComponent(call.path).includes(`${LABEL_OWNER}=${baseConfig.owner}`);
          return new Response(JSON.stringify(ownerFiltered
            ? (present ? [own] : [])
            : (present ? [own, foreign] : [foreign])), { status: 200 });
        }),
        match("GET", "/containers/ctr-own/json", () => new Response(JSON.stringify({
          Mounts: [{ Source: ownPath, Destination: "/data/profile" }],
        }), { status: 200 })),
        match("GET", "/containers/ctr-foreign/json", () => new Response(JSON.stringify({
          Mounts: [{ Source: foreignPath, Destination: "/data/profile" }],
        }), { status: 200 })),
        match("POST", "/containers/ctr-own/stop?t=5", () =>
          new Response(failing && failedOperation === "stop" ? "stop unavailable" : null,
            { status: failing && failedOperation === "stop" ? 500 : 204 })),
        match("DELETE", "/containers/ctr-own", () => {
          if (failing && failedOperation === "delete") return new Response("delete unavailable", { status: 500 });
          present = false;
          return new Response(null, { status: 204 });
        }),
      ], calls);
      try {
        const cm = createContainerManager({
          ...baseConfig, profilesWork: root, profilesHostPath: root, dockerFetch,
        });
        const failed = await cm.reap();
        expect(failed._tag).toBe("Err");
        if (failed._tag !== "Err") throw new Error("expected Docker failure");
        expect(failed.error._tag).toBe("ContainerCreateFailed");
        expect(failed.error).toHaveProperty("message", `Docker ${failedOperation} failed (500): ${failedOperation} unavailable`);
        expect(await stat(ownPath).then(() => true, () => false)).toBe(true);
        expect(calls.some((call) => call.path === "/containers/ctr-own/json")).toBe(true);
        expect(warns.some((warning) => warning.includes("[reap-failed]") && warning.includes("container=ctr-own"))).toBe(true);
        if (failedOperation === "stop") {
          expect(calls.some((call) => call.method === "DELETE" && call.path === "/containers/ctr-own")).toBe(false);
        }

        failing = false;
        expect(await cm.reap()).toEqual({ _tag: "Ok", value: { reaped: 1 } });
        expect(await stat(ownPath).then(() => true, () => false)).toBe(false);
        const foreignAfter = await stat(foreignPath);
        expect([foreignAfter.ino, foreignAfter.mtimeMs]).toEqual([foreignBefore.ino, foreignBefore.mtimeMs]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("reap waits for confirmed removal after Docker 409 and retains the profile when the wait fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-reap-wait-"));
    const sessionId = "aaaaaaaa-1111-4222-8333-555555555555";
    const path = profileDestination(root, baseConfig.owner, sessionId);
    await mkdir(path);
    let present = true;
    let waitFails = true;
    const waitRequested = Promise.withResolvers<void>();
    const releaseWait = Promise.withResolvers<void>();
    const calls: Call[] = [];
    const dockerFetch = makeFetch([
      match("GET", /^\/containers\/json/, () => {
        return new Response(JSON.stringify(present
          ? [{ Id: "ctr-own", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME, [LABEL_OWNER]: baseConfig.owner, [LABEL_SESSION_ID]: sessionId } }]
          : []), { status: 200 });
      }),
      match("GET", "/containers/ctr-own/json", () => new Response(JSON.stringify({
        Mounts: [{ Source: path, Destination: "/data/profile" }],
      }), { status: 200 })),
      match("POST", "/containers/ctr-own/stop?t=5", () => new Response(null, { status: 204 })),
      match("DELETE", "/containers/ctr-own", () =>
        new Response("removal of container ctr-own is already in progress", { status: 409 })),
      match("POST", "/containers/ctr-own/wait?condition=removed", async () => {
        if (waitFails) {
          waitRequested.resolve();
          await releaseWait.promise;
          return new Response("Docker unavailable", { status: 500 });
        }
        present = false;
        return new Response('{"StatusCode":0}', { status: 200 });
      }),
    ], calls);
    try {
      const cm = createContainerManager({
        ...baseConfig, profilesWork: root, profilesHostPath: root, dockerFetch,
      });
      const first = cm.reap();
      await waitRequested.promise;
      expect(await stat(path).then(() => true, () => false)).toBe(true);
      releaseWait.resolve();
      const failed = await first;
      expect(failed._tag).toBe("Err");
      if (failed._tag !== "Err") throw new Error("expected Docker removal wait failure");
      expect(failed.error).toHaveProperty("message", "Docker removal wait failed (500): Docker unavailable");
      expect(await stat(path).then(() => true, () => false)).toBe(true);
      expect(calls.some((call) => call.path === "/containers/ctr-own/json")).toBe(true);

      waitFails = false;
      expect(await cm.reap()).toEqual({ _tag: "Ok", value: { reaped: 1 } });
      expect(await stat(path).then(() => true, () => false)).toBe(false);
      expect(calls.filter((call) => call.path === "/containers/ctr-own/wait?condition=removed")).toHaveLength(2);
    } finally {
      releaseWait.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("destroy falls back to label lookup when the in-memory map has no entry", async () => {
    const calls: Call[] = [];
    const dockerFetch = makeFetch(
      [
        match(
          "GET",
          /^\/containers\/json/,
          () => new Response(JSON.stringify([{ Id: "found-ctr" }]), { status: 200 }),
        ),
        match("POST", "/containers/found-ctr/stop?t=5", () => new Response(null, { status: 204 })),
        match("DELETE", "/containers/found-ctr", () => new Response(null, { status: 204 })),
      ],
      calls,
    );

    const cm = createContainerManager({ ...baseConfig, dockerFetch });
    const result = await cm.destroy("sess-lost");

    expect(result._tag).toBe("Ok");
    const listCall = calls.find((c) => c.method === "GET");
    expect(decodeURIComponent(listCall?.path ?? "")).toContain(`${LABEL_SESSION_ID}=sess-lost`);
    expect(calls.some((c) => c.method === "POST" && c.path === "/containers/found-ctr/stop?t=5")).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/containers/found-ctr")).toBe(true);
  });

  it("destroy reports a missing container after removing an unmounted copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-destroy-"));
    const sessionId = "07070707-1111-4222-8333-555555555555";
    const name = `agent-${Buffer.from(baseConfig.owner).toString("base64url")}-${sessionId}`;
    await mkdir(join(root, name));
    try {
      const calls: Call[] = [];
      const dockerFetch = makeFetch(
        [match("GET", /^\/containers\/json/, () => new Response("[]", { status: 200 }))],
        calls,
      );
      const result = await createContainerManager({ ...baseConfig, profilesWork: root, dockerFetch }).destroy(sessionId);
      expect(result).toEqual({ _tag: "Err", error: { _tag: "SessionNotFound", sessionId } });
      expect(await stat(join(root, name)).then(() => true, () => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces profile deletion failure instead of reporting a missing session", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-failure-"));
    const notDirectory = join(root, "file");
    await writeFile(notDirectory, "not a directory");
    try {
      const result = await createContainerManager({
        ...baseConfig,
        profilesWork: notDirectory,
        dockerFetch: makeFetch(
          [match("GET", /^\/containers\/json/, () => new Response("[]", { status: 200 }))],
          [],
        ),
      }).destroy("07070707-1111-4222-8333-555555555555");
      expect(result._tag).toBe("Err");
      if (result._tag !== "Err") throw new Error("expected cleanup error");
      expect(result.error._tag).toBe("ProfileCleanupFailed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for Docker's removed condition after an in-progress removal before deleting only that copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-wait-"));
    const token = Buffer.from(baseConfig.owner).toString("base64url");
    const a = "aaaaaaaa-1111-4222-8333-555555555555";
    const b = "bbbbbbbb-1111-4222-8333-555555555555";
    const aPath = join(root, `agent-${token}-${a}`);
    const bPath = join(root, `agent-${token}-${b}`);
    await mkdir(aPath);
    await mkdir(bPath);
    const before = await stat(bPath);
    const waitRequested = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const dockerFetch = makeFetch([
      match("GET", /^\/containers\/json/, () => new Response('[{\"Id\":\"ctr-a\"}]', { status: 200 })),
      match("POST", "/containers/ctr-a/stop?t=5", () => new Response(null, { status: 204 })),
      match("DELETE", "/containers/ctr-a", () => new Response('removal of container ctr-a is already in progress', { status: 409 })),
      match("POST", "/containers/ctr-a/wait?condition=removed", async () => {
        waitRequested.resolve();
        await removed.promise;
        return new Response('{"StatusCode":0}', { status: 200 });
      }),
    ], []);
    try {
      const destruction = createContainerManager({ ...baseConfig, profilesWork: root, dockerFetch }).destroy(a);
      await waitRequested.promise;
      expect(await stat(aPath).then(() => true, () => false)).toBe(true);
      removed.resolve();
      const result = await destruction;
      expect(result._tag).toBe("Ok");
      expect(await stat(aPath).then(() => true, () => false)).toBe(false);
      const after = await stat(bPath);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    } finally {
      removed.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the mounted profile and reports failure when Docker cannot confirm removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-wait-failure-"));
    const sessionId = "aaaaaaaa-1111-4222-8333-555555555555";
    const path = join(root, `agent-${Buffer.from(baseConfig.owner).toString("base64url")}-${sessionId}`);
    await mkdir(path);
    const dockerFetch = makeFetch([
      match("GET", /^\/containers\/json/, () => new Response('[{\"Id\":\"ctr-a\"}]', { status: 200 })),
      match("POST", "/containers/ctr-a/stop?t=5", () => new Response(null, { status: 204 })),
      match("DELETE", "/containers/ctr-a", () => new Response('removal of container ctr-a is already in progress', { status: 409 })),
      match("POST", "/containers/ctr-a/wait?condition=removed", () => new Response("Docker unavailable", { status: 500 })),
    ], []);
    try {
      const result = await createContainerManager({ ...baseConfig, profilesWork: root, dockerFetch }).destroy(sessionId);
      expect(result._tag).toBe("Err");
      if (result._tag !== "Err") throw new Error("expected Docker failure");
      expect(result.error._tag).toBe("ContainerCreateFailed");
      expect(await stat(path).then(() => true, () => false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sweeps own and legacy orphans but preserves mounted legacy and foreign copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-sweep-"));
    const own = `agent-${Buffer.from(baseConfig.owner).toString("base64url")}-aaaaaaaa-1111-4222-8333-555555555555`;
    const legacy = "agent-bbbbbbbb-1111-4222-8333-555555555555";
    const liveLegacy = "agent-cccccccc-1111-4222-8333-555555555555";
    const foreign = "agent-Zm9yZWlnbg-dddddddd-1111-4222-8333-555555555555";
    for (const name of [own, legacy, liveLegacy, foreign]) await mkdir(join(root, name));
    const before = await stat(join(root, liveLegacy));
    const calls: Call[] = [];
    const dockerFetch = makeFetch([
      match("GET", /^\/containers\/json/, (call) => {
        const filters = decodeURIComponent(call.path);
        const containers = filters.includes(`${LABEL_ROLE}=${LABEL_ROLE_AGENT_CHROME}`)
          && !filters.includes("moat-browser.owner=")
          ? [{ Id: "foreign-container", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME, "moat-browser.owner": "foreign" } }]
          : [];
        return new Response(JSON.stringify(containers), { status: 200 });
      }),
      match("GET", "/containers/foreign-container/json", () => new Response(JSON.stringify({
        Mounts: [
          { Source: join(root, liveLegacy), Destination: "/data/profile" },
          { Source: join(root, foreign), Destination: "/data/profile" },
        ],
      }), { status: 200 })),
    ], calls);
    try {
      const result = await createContainerManager({
        ...baseConfig, profilesWork: root, profilesHostPath: root, dockerFetch,
      }).reap();
      expect(result).toEqual({ _tag: "Ok", value: { reaped: 0 } });
      expect(await stat(join(root, own)).then(() => true, () => false)).toBe(false);
      expect(await stat(join(root, legacy)).then(() => true, () => false)).toBe(false);
      const after = await stat(join(root, liveLegacy));
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(await stat(join(root, foreign)).then(() => true, () => false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete an orphan candidate when any container's mounts cannot be inspected", async () => {
    const root = await mkdtemp(join(tmpdir(), "moat-289-uncertain-"));
    const orphan = "agent-aaaaaaaa-1111-4222-8333-555555555555";
    await mkdir(join(root, orphan));
    const dockerFetch = makeFetch([
      match("GET", /^\/containers\/json/, (call) =>
        new Response(JSON.stringify(decodeURIComponent(call.path).includes("moat-browser.owner=")
          ? [] : [{ Id: "foreign-container" }]), { status: 200 })),
      match("GET", "/containers/foreign-container/json", () => new Response("unknown", { status: 500 })),
    ], []);
    try {
      const result = await createContainerManager({
        ...baseConfig, profilesWork: root, profilesHostPath: root, dockerFetch,
      }).reap();
      expect(result._tag).toBe("Err");
      expect(await stat(join(root, orphan)).then(() => true, () => false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
