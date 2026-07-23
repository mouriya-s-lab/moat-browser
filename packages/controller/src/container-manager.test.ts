import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildCreateBody,
  createContainerManager,
  LABEL_ROLE,
  LABEL_ROLE_AGENT_CHROME,
  LABEL_SESSION_ID,
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
  profilesWork: "/tmp/profiles-test",
  profilesHostPath: "/data/profiles",
  dockerNetwork: "moat",
  agentChromeImage: "agent-chrome:test",
  cdpReadyTimeout: 100,
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

  it("reap keeps going when a single container's stop fails and warns", async () => {
    const calls: Call[] = [];
    const dockerFetch = makeFetch(
      [
        match(
          "GET",
          /^\/containers\/json/,
          () =>
            new Response(
              JSON.stringify([
                { Id: "bad", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME, [LABEL_SESSION_ID]: "sess-bad" } },
                { Id: "good", Labels: { [LABEL_ROLE]: LABEL_ROLE_AGENT_CHROME, [LABEL_SESSION_ID]: "sess-good" } },
              ]),
              { status: 200 },
            ),
        ),
        match("POST", "/containers/bad/stop?t=5", () => new Response("boom", { status: 500 })),
        match("POST", "/containers/good/stop?t=5", () => new Response(null, { status: 204 })),
        match("DELETE", "/containers/good", () => new Response(null, { status: 204 })),
      ],
      calls,
    );

    const cm = createContainerManager({ ...baseConfig, dockerFetch });
    const result = await cm.reap();

    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") throw new Error("unreachable");
    expect(result.value.reaped).toBe(1);
    expect(warns.some((w) => w.includes("[reap-failed]") && w.includes("container=bad") && w.includes("session=sess-bad"))).toBe(true);
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

  it("destroy returns the classic Err when neither map nor label lookup finds the container", async () => {
    const calls: Call[] = [];
    const dockerFetch = makeFetch(
      [match("GET", /^\/containers\/json/, () => new Response("[]", { status: 200 }))],
      calls,
    );

    const cm = createContainerManager({ ...baseConfig, dockerFetch });
    const result = await cm.destroy("sess-nowhere");

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") throw new Error("unreachable");
    expect(result.error._tag).toBe("ContainerCreateFailed");
    expect("message" in result.error ? result.error.message : "").toContain("No container for session sess-nowhere");
  });
});
