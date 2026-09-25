#!/usr/bin/env bun
/** Run the real user-profile -> controller copy -> agent Chrome path, never the live user container. */
import { createReadStream, type Stats } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Stage = "arguments" | "fixture" | "user-login" | "source-manifest" | "controller-start" | "connect" | "profile-copy" | "copy-control" | "agent-boot" | "agent-password-store" | "cookies" | "marker" | "example" | "disconnect" | "empty-control" | "cleanup";
type Result<T> = { readonly _tag: "Ok"; readonly value: T } | { readonly _tag: "Fail"; readonly stage: Stage; readonly reason: string };
type Command = { readonly exit: number; readonly stdout: string; readonly stderr: string };
type Options = { readonly controller: string; readonly user: string; readonly agent: string; readonly emulationMemory: boolean };
type Entry = { readonly path: string; readonly kind: "directory" | "file" | "symlink"; readonly mtime: number; readonly hash?: string };
const ok = <T>(value: T): Result<T> => ({ _tag: "Ok", value });
const fail = (stage: Stage, reason: string): Result<never> => ({ _tag: "Fail", stage, reason });
function exhaustive(value: never): never { throw new Error(`unhandled result: ${String(value)}`); }
type TerminationSignal = "SIGINT" | "SIGTERM";
let interrupted: TerminationSignal | undefined;
let cleaning = false;
const interruption = Promise.withResolvers<void>();
const interruptSignal = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    interruption.resolve();
    interruptSignal.abort();
  });
}
function ensureRunning(): void {
  if (interrupted && !cleaning) throw new Error(`received ${interrupted}`);
}
function report(result: Result<string>): void {
  switch (result._tag) {
    case "Ok": console.log(`PASS profile-guard ${result.value}`); break;
    case "Fail": console.error(`FAIL [${result.stage}] ${result.reason.replaceAll("\n", " ")}`); process.exitCode = 1; break;
    default: exhaustive(result);
  }
}
function parseOptions(argv: string[]): Result<Options> {
  const entries = new Map<string, string>();
  let emulationMemory = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--emulation-memory-1g") { emulationMemory = true; continue; }
    if (flag !== "--controller-image" && flag !== "--user-image" && flag !== "--agent-image") return fail("arguments", `unknown argument ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--") || entries.has(flag)) return fail("arguments", `missing/duplicate value for ${flag}`);
    entries.set(flag, value);
  }
  const controller = entries.get("--controller-image"), user = entries.get("--user-image"), agent = entries.get("--agent-image");
  if (!controller || !user || !agent || !process.env.MOAT) return fail("arguments", "require MOAT and --controller-image, --user-image, --agent-image");
  return ok({ controller, user, agent, emulationMemory });
}
async function command(argv: string[], env?: Record<string, string>, timeout = 90_000, probe?: () => Promise<void>, cwd?: string): Promise<Command> {
  ensureRunning();
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let finished = false;
  const exit = child.exited.then(code => { finished = true; return code; });
  const deadline = Date.now() + timeout;
  try {
    if (probe) {
      while (!finished && Date.now() < deadline) {
        ensureRunning();
        await probe();
        if (!finished) await Bun.sleep(120);
      }
    } else {
      const timeoutReached = Promise.withResolvers<void>();
      const timer = setTimeout(timeoutReached.resolve, timeout);
      try {
        await Promise.race(cleaning ? [exit, timeoutReached.promise] : [exit, timeoutReached.promise, interruption.promise]);
      } finally { clearTimeout(timer); }
    }
    ensureRunning();
    if (!finished) child.kill(9);
    const code = await exit;
    return { exit: Date.now() <= deadline ? code : 124, stdout: await stdout, stderr: await stderr };
  } catch (error) {
    if (!finished) child.kill(9);
    await exit;
    throw error;
  }
}
const diagnostic = (result: Command): string => `exit=${result.exit} stdout=${JSON.stringify(result.stdout.trim().slice(-1000))} stderr=${JSON.stringify(result.stderr.trim().slice(-1000))}`;
async function checked(stage: Stage, argv: string[], timeout?: number): Promise<Result<Command>> {
  const result = await command(argv, undefined, timeout);
  return result.exit === 0 ? ok(result) : fail(stage, `${argv[0]} ${argv[1] ?? ""}: ${diagnostic(result)}`);
}
async function cdpCommand(socket: WebSocket, method: "Target.createTarget" | "Target.closeTarget" | "Storage.getCookies" | "Browser.close", params?: { readonly url: string } | { readonly targetId: string }): Promise<unknown> {
  ensureRunning();
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} timed out`)); }, 15_000);
  function cleanup(): void {
    clearTimeout(timer);
    socket.removeEventListener("message", onMessage);
    interruptSignal.signal.removeEventListener("abort", onAbort);
  }
  function onAbort(): void {
    cleanup();
    reject(new Error(`received ${interrupted}`));
  }
  function onMessage(event: MessageEvent): void {
    let message: unknown;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message !== "object" || message === null || !("id" in message) || message.id !== 1) return;
    cleanup();
    if ("error" in message) reject(new Error(`CDP ${method}: ${JSON.stringify(message.error)}`));
    else resolve("result" in message ? message.result : undefined);
  }
  interruptSignal.signal.addEventListener("abort", onAbort, { once: true });
  socket.addEventListener("message", onMessage);
  socket.send(JSON.stringify({ id: 1, method, params }));
  return promise;
}
function cliData(response: Command): unknown {
  try {
    const envelope: unknown = JSON.parse(response.stdout);
    return typeof envelope === "object" && envelope !== null && "success" in envelope &&
      envelope.success === true && "data" in envelope ? envelope.data : undefined;
  } catch { return undefined; }
}
function cliSnapshot(response: Command): string | undefined {
  const data = cliData(response);
  return typeof data === "object" && data !== null && "snapshot" in data && typeof data.snapshot === "string" ? data.snapshot : undefined;
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function manifest(root: string): Promise<Entry[]> {
  const found = await command(["find", ".", "-path", "./Singleton*", "-prune", "-o", "-print0"], undefined, 90_000, undefined, root);
  if (found.exit !== 0) throw new Error(`source find manifest failed: ${diagnostic(found)}`);
  const entries: Entry[] = [];
  for (const relative of found.stdout.split("\0").filter(path => path.startsWith("./")).sort()) {
    const path = relative.slice(2), absolute = join(root, path), info = await lstat(absolute);
    if (info.isDirectory()) entries.push({ path, kind: "directory", mtime: info.mtimeMs });
    else if (info.isFile()) entries.push({ path, kind: "file", mtime: info.mtimeMs, hash: await hashFile(absolute) });
    else if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", mtime: info.mtimeMs });
    else throw new Error(`unsupported profile entry ${path}`);
  }
  return entries;
}
type CopyComparison = { readonly missing: readonly string[]; readonly unchanged: number };
async function compare(source: Entry[], dest: string): Promise<Result<CopyComparison>> {
  let unchanged = 0;
  const missing: string[] = [];
  const sentinel = new Set(["Default/moat-sentinel/a/b/blob", "moat-top-sentinel"]);
  for (const entry of source) {
    let info: Stats;
    try { info = await lstat(join(dest, entry.path)); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (sentinel.has(entry.path) || entry.path === "Local State") return fail("profile-copy", `protected source entry missing: ${entry.path}`);
      missing.push(entry.path);
      continue;
    }
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other";
    if (kind !== entry.kind) return fail("profile-copy", `entry type changed: ${entry.path} ${entry.kind} -> ${kind}`);
    if (entry.kind === "file" && entry.mtime === info.mtimeMs) {
      const hash = await hashFile(join(dest, entry.path));
      if (hash !== entry.hash) return fail("profile-copy", `sha256 differs despite preserved mtime: ${entry.path}`);
      unchanged++;
      sentinel.delete(entry.path);
    }
  }
  if (sentinel.size) return fail("profile-copy", `sentinel mtime/hash changed: ${[...sentinel].join(",")}`);
  try { await lstat(join(dest, "SingletonGuard")); return fail("profile-copy", "top-level SingletonGuard remains in copy"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { /* expected */ } else throw error; }
  return ok({ missing, unchanged });
}
async function main(options: Options): Promise<Result<string>> {
  const runId = `moat287-${randomUUID().slice(0, 12)}`;
  const owner = runId;
  const base = await mkdtemp(join(tmpdir(), "moat287-"));
  const source = join(base, "source"), profiles = join(base, "profiles"), empty = join(base, "empty"), home = join(base, "home"), reference = join(base, "reference");
  const fixture = `${runId}-fixture`, controller = `${runId}-controller`, browser = `${runId}-user`, control = `${runId}-reference`;
  const names = [fixture, controller, browser, `${browser}-cdp`, control, `${control}-chown`];
  let networkCreated = false;
  let sessionActive = false;
  let currentStage: Stage = "fixture";
  const paused = new Set<string>();
  const browserUrl = `http://${fixture}:8000`;
  const moat = resolve(process.env.MOAT!);
  async function cli(argv: string[]): Promise<Command> {
    return command([moat, "--json", ...argv], { HOME: home, MOAT_CONTROLLER: controllerUrl }, 90_000);
  }
  let controllerUrl = "";
  async function startController(profile: string): Promise<Result<string>> {
    currentStage = "controller-start";
    const started = await checked(currentStage, ["docker", "run", "-d", "--name", controller, "--network", runId,
      "--label", `moat287.owner=${owner}`, "-p", "127.0.0.1::3000", "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${profile}:/data/profile:ro`, "-v", `${profiles}:/data/profiles`,
      "-e", "PROFILE_SOURCE=/data/profile", "-e", "PROFILES_WORK=/data/profiles", "-e", `PROFILES_HOST_PATH=${profiles}`,
      "-e", `DOCKER_NETWORK=${runId}`, "-e", `AGENT_CHROME_IMAGE=${options.agent}`, "-e", `CONTROLLER_OWNER=${owner}`, options.controller]);
    if (started._tag === "Fail") return started;
    const port = await checked(currentStage, ["docker", "port", controller, "3000/tcp"]);
    if (port._tag === "Fail") return port;
    const match = port.value.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (!match) return fail(currentStage, `cannot resolve loopback controller port: ${port.value.stdout}`);
    controllerUrl = `ws://127.0.0.1:${match[1]}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await command(["docker", "logs", controller]);
      if (result.stdout.includes("[startup-reap]") && result.stdout.includes("expected agent-chrome version") &&
          result.stdout.includes("Controller listening")) {
        const startup = result.stdout.split("\n").filter(line =>
          line.startsWith("[browser-anchor]") || line.startsWith("[startup-reap]") ||
          line.startsWith("[admission-reconcile]") || line.startsWith("Controller listening"));
        console.log(`OBSERVE [controller-start] ${startup.join(" | ")}`);
        return ok(controllerUrl);
      }
      await Bun.sleep(250);
    }
    return fail(currentStage, `controller did not start: ${diagnostic(await command(["docker", "logs", controller]))}`);
  }
  async function connect(): Promise<Result<{ sessionId: string; agent: string }>> {
    currentStage = "connect";
    let updated = false;
    const result = await command([moat, "--json", "connect"], { HOME: home, MOAT_CONTROLLER: controllerUrl }, 90_000,
      options.emulationMemory ? async () => {
        if (updated) return;
        const listed = await command(["docker", "ps", "-q", "--filter", `label=moat-browser.owner=${owner}`]);
        const id = listed.stdout.trim().split("\n")[0];
        if (listed.exit === 0 && id) {
          const update = await command(["docker", "update", "--memory=1g", "--memory-swap=1g", id]);
          if (update.exit !== 0) throw new Error(`emulation-only memory update: ${diagnostic(update)}`);
          console.log(`OBSERVE [connect] emulation-only docker update --memory=1g --memory-swap=1g ${id}`);
          updated = true;
        }
      } : undefined);
    if (result.exit !== 0) return fail(currentStage, `version refusal or browser startup: ${diagnostic(result)}`);
    let payload: unknown;
    try { payload = JSON.parse(result.stdout); }
    catch { return fail(currentStage, `invalid connect JSON: ${diagnostic(result)}`); }
    const data = typeof payload === "object" && payload !== null && "data" in payload ? payload.data : undefined;
    const sessionId = typeof data === "object" && data !== null && "sessionId" in data ? data.sessionId : undefined;
    if (typeof payload !== "object" || payload === null || !("success" in payload) || payload.success !== true || typeof sessionId !== "string") return fail(currentStage, `invalid connect response ${diagnostic(result)}`);
    sessionActive = true;
    const listed = await checked(currentStage, ["docker", "ps", "-q", "--filter", `label=moat-browser.owner=${owner}`, "--filter", `label=moat-browser.session-id=${sessionId}`]);
    if (listed._tag === "Fail") return listed;
    const agent = listed.value.stdout.trim();
    if (!agent || agent.includes("\n")) return fail(currentStage, `expected one owned agent container, found ${JSON.stringify(agent)}`);
    return ok({ sessionId, agent });
  }
  async function cliStep(stage: Stage, argv: string[]): Promise<Result<Command>> {
    currentStage = stage;
    const result = await cli(argv);
    return result.exit === 0 ? ok(result) : fail(stage, `moat ${argv.join(" ")}: ${diagnostic(result)}`);
  }
  try {
    await Promise.all([mkdir(source), mkdir(profiles), mkdir(empty), mkdir(home)]);
    await chmod(source, 0o777);
    const network = await checked("fixture", ["docker", "network", "create", "--label", `moat287.owner=${owner}`, runId]);
    if (network._tag === "Fail") return network;
    networkCreated = true;
    const fixtureStart = await checked("fixture", ["docker", "run", "-d", "--name", fixture, "--network", runId,
      "--label", `moat287.owner=${owner}`, "-v", `${join(import.meta.dir, "profile-guard-fixture.mjs")}:/fixture.mjs:ro`,
      "node:22-slim", "node", "/fixture.mjs"]);
    if (fixtureStart._tag === "Fail") return fixtureStart;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const response = await command(["docker", "exec", fixture, "node", "-e",
        "fetch('http://localhost:8000/me').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"]);
      if (response.exit === 0) { ready = true; break; }
      await Bun.sleep(200);
    }
    if (!ready) return fail("fixture", `auth fixture unavailable: ${diagnostic(await command(["docker", "logs", fixture]))}`);
    console.log(`OBSERVE [fixture] network=${runId} /me=401 before login`);

    currentStage = "user-login";
    const launched = await checked(currentStage, ["docker", "run", "-d", "--name", browser, "--network", runId,
      "--label", `moat287.owner=${owner}`, "-p", "127.0.0.1::9222", "--user", "1000:1000", "-e", "HOME=/home/neko", "-v", `${source}:/home/neko/.config/chromium`,
      "--entrypoint", "/opt/chrome/chrome", options.user, "--headless=new", "--no-sandbox", "--disable-gpu",
      "--disable-dev-shm-usage", "--no-first-run", "--password-store=basic", "--user-data-dir=/home/neko/.config/chromium",
      "--remote-debugging-port=9223", "about:blank"]);
    if (launched._tag === "Fail") return launched;
    const relay = await checked(currentStage, ["docker", "run", "-d", "--name", `${browser}-cdp`, "--network", `container:${browser}`,
      "--label", `moat287.owner=${owner}`, "--entrypoint", "/usr/bin/socat", options.agent,
      "TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0", "TCP:127.0.0.1:9223"]);
    if (relay._tag === "Fail") return relay;
    const port = await checked(currentStage, ["docker", "port", browser, "9222/tcp"]);
    if (port._tag === "Fail") return port;
    const hostPort = port.value.stdout.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!hostPort) return fail(currentStage, `browser CDP port unavailable: ${port.value.stdout}`);
    let socket: WebSocket | undefined;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const version: unknown = await response.json();
          if (typeof version === "object" && version !== null && "webSocketDebuggerUrl" in version && typeof version.webSocketDebuggerUrl === "string") {
            const endpoint = new URL(version.webSocketDebuggerUrl);
            endpoint.hostname = "127.0.0.1";
            endpoint.port = hostPort;
            socket = new WebSocket(endpoint);
            const opened = Promise.withResolvers<void>();
            const timer = setTimeout(() => opened.reject(new Error("source CDP WebSocket timeout")), 5000);
            socket.addEventListener("open", () => { clearTimeout(timer); opened.resolve(); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); opened.reject(new Error("source CDP WebSocket failed")); }, { once: true });
            await opened.promise;
            break;
          }
        }
      } catch { /* source Chrome may still be starting */ }
      await Bun.sleep(250);
    }
    if (!socket) return fail(currentStage, `source Chrome CDP unavailable: ${diagnostic(await command(["docker", "logs", browser]))}`);
    const created = await cdpCommand(socket, "Target.createTarget", { url: `${browserUrl}/login` });
    const targetId = typeof created === "object" && created !== null && "targetId" in created ? created.targetId : undefined;
    if (typeof targetId !== "string") return fail(currentStage, `source /login tab creation failed: ${JSON.stringify(created)}`);
    let session: string | undefined;
    let received = false;
    for (let i = 0; i < 120; i++) {
      const fixtureLogs = await command(["docker", "logs", fixture]);
      session = [...fixtureLogs.stdout.matchAll(/ISSUED session=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
      if (session) {
        const response = await cdpCommand(socket, "Storage.getCookies");
        const cookies = typeof response === "object" && response !== null && "cookies" in response ? response.cookies : undefined;
        received = Array.isArray(cookies) && cookies.some(cookie =>
          typeof cookie === "object" && cookie !== null && "name" in cookie && "value" in cookie &&
          cookie.name === "moat_session" && cookie.value === session);
        if (received) break;
      }
      await Bun.sleep(250);
    }
    if (!session || !received) return fail(currentStage, `source Chrome did not receive a session cookie: ${diagnostic(await command(["docker", "logs", fixture]))}`);
    await cdpCommand(socket, "Target.closeTarget", { targetId });
    await cdpCommand(socket, "Browser.close").catch(() => undefined);
    socket.close();
    const exited = await checked(currentStage, ["docker", "wait", browser], 30_000);
    if (exited._tag === "Fail" || exited.value.stdout.trim() !== "0") return fail(currentStage, `source Chrome did not exit cleanly: ${exited._tag === "Fail" ? exited.reason : diagnostic(exited.value)}`);
    const sourceFixtureLogs = await checked(currentStage, ["docker", "logs", fixture]);
    if (sourceFixtureLogs._tag === "Fail") return sourceFixtureLogs;
    const issued = [...sourceFixtureLogs.value.stdout.matchAll(/ISSUED session=([A-Za-z0-9_-]+)/g)].map(match => match[1]);
    if (issued.length !== 1 || issued[0] !== session) return fail(currentStage, `source issued sessions differ from CDP cookie: ${JSON.stringify(issued)}`);
    const sealed = await checked(currentStage, ["docker", "exec", fixture, "node", "-e",
      "fetch('http://localhost:8000/seal',{method:'POST'}).then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))"]);
    if (sealed._tag === "Fail") return sealed;
    console.log(`OBSERVE [user-login] source CDP confirmed session=${session}; Browser.close exit=0; fixture /login sealed before agent startup`);
    currentStage = "source-manifest";
    await mkdir(join(source, "Default", "moat-sentinel", "a", "b"), { recursive: true });
    await writeFile(join(source, "Default", "moat-sentinel", "a", "b", "blob"), randomBytes(96));
    await writeFile(join(source, "moat-top-sentinel"), randomBytes(96));
    await writeFile(join(source, "SingletonGuard"), "discard top-level singleton");
    const entries = await manifest(source);
    if (!entries.some(entry => entry.path === "Local State")) return fail(currentStage, "Chrome source omitted Local State");
    console.log(`OBSERVE [source-manifest] entries=${entries.length} Local State=yes sentinels=2`);
    const running = await startController(source);
    if (running._tag === "Fail") return running;
    const connected = await connect();
    if (connected._tag === "Fail") return connected;
    currentStage = "copy-control";
    const copied = await checked(currentStage, ["cp", "-a", source, reference]);
    if (copied._tag === "Fail") return copied;
    for (const name of await readdir(reference)) {
      if (name.startsWith("Singleton")) await rm(join(reference, name), { recursive: true, force: true });
    }
    const owned = await checked(currentStage, ["docker", "run", "--rm", "--name", `${control}-chown`, "--label", `moat287.owner=${owner}`,
      "--user", "root", "-v", `${reference}:/data/profile`, "--entrypoint", "/bin/chown", options.agent, "-R", "1000:1000", "/data/profile"]);
    if (owned._tag === "Fail") return owned;
    const controlRun = await checked(currentStage, ["docker", "run", "-d", "--name", control, "--network", runId,
      "--label", `moat287.owner=${owner}`, "--shm-size=2g", "--memory=384m", "--memory-swap=384m",
      "-v", `${reference}:/data/profile`, options.agent]);
    if (controlRun._tag === "Fail") return controlRun;
    if (options.emulationMemory) {
      const updated = await checked(currentStage, ["docker", "update", "--memory=1g", "--memory-swap=1g", control]);
      if (updated._tag === "Fail") return updated;
      console.log(`OBSERVE [copy-control] emulation-only docker update --memory=1g --memory-swap=1g ${control}`);
    }
    const ip = await checked(currentStage, ["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", control]);
    if (ip._tag === "Fail") return ip;
    const controlIp = ip.value.stdout.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(controlIp)) return fail(currentStage, `reference IP invalid: ${controlIp}`);
    let controlReady = false;
    for (let i = 0; i < 120; i++) {
      const response = await command(["docker", "exec", controller, "node", "-e",
        `fetch("http://${controlIp}:9222/json/version").then(r=>r.json()).then(v=>{if(!/^Chrome\\/\\d+(\\.\\d+){3}$/.test(v.Browser))process.exit(1);console.log(v.Browser)}).catch(()=>process.exit(1))`], undefined, 3000);
      if (response.exit === 0) { controlReady = true; console.log(`OBSERVE [copy-control] CDP=${response.stdout.trim()}`); break; }
      await Bun.sleep(250);
    }
    if (!controlReady) return fail(currentStage, `reference agent Chrome CDP unavailable: ${diagnostic(await command(["docker", "logs", control]))}`);
    for (const id of [connected.value.agent, control]) {
      paused.add(id);
      const frozen = await checked("profile-copy", ["docker", "pause", id]);
      if (frozen._tag === "Fail") { paused.delete(id); return frozen; }
    }
    console.log("OBSERVE [profile-copy] candidate and reference paused after CDP readiness for stable manifest reads");
    currentStage = "profile-copy";
    const copy = await compare(entries, join(profiles, `agent-${Buffer.from(owner).toString("base64url")}-${connected.value.sessionId}`));
    if (copy._tag === "Fail") return copy;
    console.log(`OBSERVE [profile-copy] entries=${entries.length} unchanged-hashes=${copy.value.unchanged} sentinels=2 missing=${copy.value.missing.length}`);
    currentStage = "copy-control";
    const referenceCopy = await compare(entries, reference);
    if (referenceCopy._tag === "Fail") return fail(currentStage, referenceCopy.reason);
    const actualMissing = [...copy.value.missing].sort(), controlMissing = [...referenceCopy.value.missing].sort();
    for (const path of actualMissing) console.log(`OBSERVE [profile-copy] browser-removed=${path}`);
    if (JSON.stringify(actualMissing) !== JSON.stringify(controlMissing))
      return fail(currentStage, `controller missing=${JSON.stringify(actualMissing)} reference missing=${JSON.stringify(controlMissing)}`);
    console.log(`OBSERVE [copy-control] entries=${entries.length} unchanged-hashes=${referenceCopy.value.unchanged} same-browser-removals=${controlMissing.length}`);
    for (const id of [control, connected.value.agent]) {
      const resumed = await checked(currentStage, ["docker", "unpause", id]);
      if (resumed._tag === "Fail") return resumed;
      paused.delete(id);
    }
    const controlLogs = await checked(currentStage, ["docker", "logs", control]);
    if (controlLogs._tag === "Fail") return controlLogs;
    if (controlLogs.value.stdout.concat(controlLogs.value.stderr).includes("SIGTRAP")) return fail(currentStage, "reference agent SIGTRAP");
    const controlStopped = await checked(currentStage, ["docker", "rm", "-f", control]);
    if (controlStopped._tag === "Fail") return controlStopped;
    currentStage = "agent-boot";
    const logs = await checked(currentStage, ["docker", "logs", connected.value.agent]);
    if (logs._tag === "Fail") return logs;
    const traps = logs.value.stdout.concat(logs.value.stderr).split("SIGTRAP").length - 1;
    if (traps !== 0) return fail(currentStage, `agent docker logs SIGTRAP count=${traps}`);
    console.log(`OBSERVE [agent-boot] SIGTRAP count=${traps}`);
    currentStage = "agent-password-store";
    const ps = await checked(currentStage, ["docker", "exec", connected.value.agent, "sh", "-c", "for p in /proc/[0-9]*; do tr '\\0' ' ' <$p/cmdline 2>/dev/null; echo; done"]);
    if (ps._tag === "Fail") return ps;
    const browserProcessCount = ps.value.stdout.split("\n").filter(line =>
      line.includes("/usr/local/bin/chrome") && line.includes("--password-store=basic")).length;
    if (browserProcessCount < 1) return fail(currentStage, "agent Chrome main process lacks --password-store=basic");
    console.log(`OBSERVE [agent-password-store] Chrome process --password-store=basic count=${browserProcessCount}`);
    const cookies = await cliStep("cookies", ["cookies"]);
    if (cookies._tag === "Fail") return cookies;
    const cookieData = cliData(cookies.value);
    const receivedCookies = typeof cookieData === "object" && cookieData !== null && "cookies" in cookieData ? cookieData.cookies : undefined;
    if (!Array.isArray(receivedCookies) || !receivedCookies.some(cookie =>
      typeof cookie === "object" && cookie !== null && "name" in cookie && "value" in cookie &&
      cookie.name === "moat_session" && cookie.value === session)) return fail("cookies", `session cookie missing: ${diagnostic(cookies.value)}`);
    console.log(`OBSERVE [cookies] moat_session=${session}`);
    const opened = await cliStep("marker", ["open", `${browserUrl}/me`]);
    if (opened._tag === "Fail") return opened;
    const snapshot = await cliStep("marker", ["snapshot"]);
    if (snapshot._tag === "Fail") return snapshot;
    if (!cliSnapshot(snapshot.value)?.includes(session)) return fail("marker", `authenticated /me session does not match ${session}: ${diagnostic(snapshot.value)}`);
    console.log(`OBSERVE [marker] /me same session=${session} without visiting /login`);
    const example = await cliStep("example", ["open", "https://example.com"]);
    if (example._tag === "Fail") return example;
    const exampleSnapshot = await cliStep("example", ["snapshot"]);
    if (exampleSnapshot._tag === "Fail") return exampleSnapshot;
    if (!cliSnapshot(exampleSnapshot.value)?.includes('heading "Example Domain"')) return fail("example", `unexpected example snapshot: ${diagnostic(exampleSnapshot.value)}`);
    console.log('OBSERVE [example] heading "Example Domain"');
    const disconnected = await cliStep("disconnect", ["disconnect"]);
    if (disconnected._tag === "Fail") return disconnected;
    sessionActive = false;
    const stopped = await checked("empty-control", ["docker", "rm", "-f", controller]);
    if (stopped._tag === "Fail") return stopped;
    const restarted = await startController(empty);
    if (restarted._tag === "Fail") return restarted;
    const emptyConnected = await connect();
    if (emptyConnected._tag === "Fail") return emptyConnected;
    const emptyOpen = await cliStep("empty-control", ["open", `${browserUrl}/me`]);
    if (emptyOpen._tag === "Fail") return emptyOpen;
    const emptySnapshot = await cliStep("empty-control", ["snapshot"]);
    if (emptySnapshot._tag === "Fail") return emptySnapshot;
    if (!cliSnapshot(emptySnapshot.value)?.includes("unauthenticated") || cliSnapshot(emptySnapshot.value)?.includes(session)) return fail("empty-control", `empty profile received prior session: ${diagnostic(emptySnapshot.value)}`);
    console.log("OBSERVE [empty-control] /me=unauthenticated with fresh empty profile");
    const emptyDisconnect = await cliStep("disconnect", ["disconnect"]);
    if (emptyDisconnect._tag === "Fail") return emptyDisconnect;
    sessionActive = false;
    return ok(`session=${session} profile entries=${entries.length} unchanged hashes verified; SIGTRAP=0; empty profile unauthenticated`);
  } catch (error) {
    return fail(currentStage, error instanceof Error ? error.message : String(error));
  } finally {
    cleaning = true;
    const cleanupErrors: string[] = [];
    for (const id of paused) {
      const state = await command(["docker", "inspect", "-f", "{{.State.Paused}}", id]);
      if (state.exit === 0 && state.stdout.trim() === "true") {
        const resumed = await command(["docker", "unpause", id]);
        if (resumed.exit !== 0) cleanupErrors.push(`unpause ${id}: ${diagnostic(resumed)}`);
      }
    }
    if (interrupted) {
      // Stop the only process able to create more owned agents before inventory.
      const stopped = await command(["docker", "rm", "-f", controller]);
      if (stopped.exit !== 0 && !stopped.stderr.includes("No such container")) cleanupErrors.push(`stop controller: ${diagnostic(stopped)}`);
    } else if (sessionActive && controllerUrl) {
      const result = await cli(["disconnect"]);
      if (result.exit !== 0) cleanupErrors.push(`disconnect: ${diagnostic(result)}`);
    }
    const listed = await command(["docker", "ps", "-aq", "--filter", `label=moat-browser.owner=${owner}`]);
    if (listed.exit !== 0) cleanupErrors.push(`list owned agents: ${diagnostic(listed)}`);
    else names.push(...listed.stdout.trim().split("\n").filter(Boolean));
    await command(["docker", "rm", "-f", ...new Set(names)]);
    const remaining = await command(["docker", "ps", "-aq", "--filter", `label=moat-browser.owner=${owner}`]);
    if (remaining.exit !== 0 || remaining.stdout.trim()) cleanupErrors.push(`owned agents remain: ${diagnostic(remaining)}`);
    const named = await command(["docker", "ps", "-aq", "--filter", `name=^/${runId}-`]);
    if (named.exit !== 0 || named.stdout.trim()) cleanupErrors.push(`named test containers remain: ${diagnostic(named)}`);
    if (networkCreated) {
      const net = await command(["docker", "network", "rm", runId]);
      if (net.exit !== 0) cleanupErrors.push(`remove network: ${diagnostic(net)}`);
    }
    try { await rm(base, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(`remove temporary profile: ${String(error)}`); }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
  }
}
const parsed = parseOptions(process.argv.slice(2));
if (parsed._tag === "Fail") report(parsed);
else {
  try {
    const result = await main(parsed.value);
    report(interrupted && result._tag === "Ok" ? fail("cleanup", `received ${interrupted}`) : result);
  }
  catch (error) { report(fail("cleanup", error instanceof Error ? error.message : String(error))); }
}
