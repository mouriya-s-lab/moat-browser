#!/usr/bin/env bun
/** Exhaustive, black-box moat CLI contract runner for issue #228. */
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Availability = "controller" | "local" | "orchestrated" | "stable_unsupported";
type EntryKind = "static" | "dynamic";
type Case = { action: string; argv: string[]; availability: Availability; verify?: string[]; contains?: string; notContains?: string; artifacts?: string[] };
type ContractEntry = { action: string; sourceKind: EntryKind; dynamicSources: string[]; availability: Availability };
type Contract = { entries: ContractEntry[]; topLevel: Record<string, TopLevelKind>; gaps: Record<string, string[]>; counts: Record<string, number> };
type Run = { exit: number; stdout: string; stderr: string; value?: Record<string, unknown>; jsonValues: number };
type TopLevelKind = "local_output" | "local_session" | "controller_session" | "stable_unsupported";
type TopLevelResult = { name: string; kind: TopLevelKind; argv: string[]; exit: number; passed: boolean; jsonValues: number; diagnostic: string };

const root = resolve(import.meta.dir, "../..");
const moat = resolve(process.env.MOAT ?? join(root, "cli/target/release/moat"));
const controller = process.env.MOAT_CONTROLLER ?? "ws://browser.hb.lan:3000";
const resultPath = join(import.meta.dir, "cli-all-commands-results.json");
const ownHome = !process.env.HOME || process.argv.includes("--verify-isolation");
const home = ownHome ? await mkdtemp(join(tmpdir(), "moat-cli-e2e-")) : process.env.HOME!;
const artifacts = join(home, "artifacts");
await mkdir(artifacts, { recursive: true });
await mkdir(join(home, ".moat", "states"), { recursive: true });
const upload = join(artifacts, "upload.txt");
await writeFile(upload, "moat upload fixture\n");

const html = `<!doctype html><title>Moat CLI Matrix</title><style>body{min-height:1800px}.box{width:80px;height:30px}</style>
<h1 title="matrix-title">Moat CLI Matrix</h1><label>Name <input id="input" placeholder="Your name" data-testid="name"></label>
<button id="button" onclick="this.dataset.clicked='yes'">Run</button><input id="check" type="checkbox"><select id="select"><option value="a">A</option><option value="b">B</option></select>
<img alt="pixel" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div id="source" draggable="true">drag</div><div id="target">drop</div>
<input id="file" type="file"><a href="/target">Target</a><a id="download" download="fixture.txt" href="data:text/plain,download-ok">download</a><button id="prompt" onclick="prompt('value?')">prompt</button><output id="route">initial</output><script>if(location.pathname === '/router')window.next={router:{push(url){history.pushState(null,'',url);document.querySelector('#route').textContent='router:'+url}}}</script>
<iframe id="frame" srcdoc="<p id='inside'>frame</p>"></iframe>`;
// A non-opaque origin is mandatory: cookies, local/session storage, permission
// grants, state save/load, and request headers cannot be proven on a data URL.
// The runner installs the deterministic DOM after each navigation that would
// otherwise replace it.
const fixture = process.env.MOAT_FIXTURE_URL ?? "https://example.com/";
const installFixtureArgv = ["eval", `document.open();document.write(${JSON.stringify(html)});document.close();window.matrixReady=true;window.matrixEvents=[];localStorage.clear();sessionStorage.clear();console.log('matrix-console');for(const event of ['dblclick','focus','keydown','keyup','mousemove','mousedown','mouseup','wheel','touchstart','touchend','drop','popstate','navigate']){const target=event==='popstate'||event==='navigate'?window:document;target.addEventListener(event,()=>window.matrixEvents.push(event));}document.addEventListener('dragover',e=>e.preventDefault());true`];

const C = (action: string, argv: string[], verify?: string[], contains?: string, notContains?: string, artifacts?: string[]): Case => ({ action, argv, availability: "controller", verify, contains, notContains, artifacts });
const L = (action: string, argv: string[], verify?: string[], contains?: string, notContains?: string): Case => ({ action, argv, availability: "local", verify, contains, notContains });
const O = (action: string, argv: string[], artifacts?: string[]): Case => ({ action, argv, availability: "orchestrated", artifacts });
const U = (action: string, argv: string[]): Case => ({ action, argv, availability: "stable_unsupported" });
const shot = join(artifacts, "screen.png"), pdf = join(artifacts, "page.pdf"), state = "matrix-state";
const statePath = join(home, ".moat", "states", `${state}.json`);
const cases: Case[] = [
  C("cookies_clear", ["cookies", "clear"]), C("navigate", ["open", fixture]),
  C("url", ["get","url"]), C("title",["get","title"],undefined,"Moat CLI Matrix"), C("back",["back"]), C("forward",["forward"]), C("reload",["reload"]),
  C("pushstate",["pushstate","/matrix-pushstate"],["eval","window.matrixEvents.filter(x => x === 'popstate' || x === 'navigate').join(',')"],"popstate,navigate"),
  C("addinitscript",["addinitscript","(() => { const mark = () => { if (document.body) document.body.dataset.moatMatrixInit = 'active'; }; mark(); window.addEventListener('DOMContentLoaded', mark); })()"]), C("removeinitscript",["removeinitscript","missing-matrix-init-script"]),
  C("click",["click","#button"],["eval","document.querySelector('#button').dataset.clicked"],"yes"), C("dblclick",["dblclick","#button"],["eval","window.matrixEvents.includes('dblclick')"],"true"),
  C("fill",["fill","#input","filled"],["get","value","#input"],"filled"), C("type",["type","#input","-typed"],["get","value","#input"],"typed"),
  C("hover",["hover","#button"],["eval","document.querySelector('#button').matches(':hover')"],"true"), C("focus",["focus","#input"],["eval","document.activeElement.id"],"input"), C("check",["check","#check"],["is","checked","#check"],"true"),
  C("uncheck",["uncheck","#check"],["is","checked","#check"],"false"), C("select",["select","#select","b"],["get","value","#select"],"b"),
  C("drag",["drag","#source","#target"],["eval","window.matrixEvents.includes('drop')"],"true"), C("upload",["upload","#file",upload],["eval","document.querySelector('#file').files[0].name"],"upload.txt"), C("download",["download","#download",join(artifacts,"download.txt")],undefined,undefined,undefined,[join(artifacts,"download.txt")]),
  C("press",["press","Tab"],["eval","document.activeElement !== document.body"],"true"), C("keydown",["keydown","Shift"],["eval","window.matrixEvents.includes('keydown')"],"true"), C("keyup",["keyup","Shift"],["eval","window.matrixEvents.includes('keyup')"],"true"), C("keyboard",["keyboard","type","keyboard"],["get","value","#input"],"keyboard"),
  C("scroll",["scroll","down","100"],["eval","window.scrollY > 0"],"true"), C("scrollintoview",["scrollintoview","#target"],["eval","document.querySelector('#target').getBoundingClientRect().top < innerHeight"],"true"), C("wait",["wait","10"]),
  C("waitforurl",["wait","--url",`${new URL(fixture).origin}/*`]), C("waitforloadstate",["wait","--load","domcontentloaded"]), C("waitforfunction",["wait","--fn","document.querySelector('h1')?.textContent === 'Moat CLI Matrix'"]),
  C("waitfordownload",["wait","--download",join(artifacts,"wait-download.txt"),"--timeout","10000"],undefined,undefined,undefined,[join(artifacts,"wait-download.txt")]),
  C("screenshot",["screenshot",shot],undefined,undefined,undefined,[shot]), C("pdf",["pdf",pdf],undefined,undefined,undefined,[pdf]), C("snapshot",["snapshot","-i"]), C("snapshot_urls",["snapshot","-i","--urls","-s","body"],undefined,new URL("/target",fixture).toString()), C("evaluate",["eval","document.title"],undefined,"Moat CLI Matrix"),
  C("gettext",["get","text","h1"],undefined,"Moat CLI Matrix"), C("innerhtml",["get","html","h1"]), C("inputvalue",["get","value","#input"]),
  C("getattribute",["get","attr","h1","title"],undefined,"matrix-title"), C("count",["get","count","button"]), C("boundingbox",["get","box","h1"]), C("styles",["get","styles","h1"]), C("cdp_url",["get","cdp-url"]),
  C("isvisible",["is","visible","h1"],undefined,"true"), C("isenabled",["is","enabled","#button"],undefined,"true"), C("ischecked",["is","checked","#check"]),
  C("getbyrole",["find","role","heading","--name","Moat CLI Matrix"]), C("getbytext",["find","text","Moat CLI Matrix"]), C("getbylabel",["find","label","Name"]),
  C("getbyplaceholder",["find","placeholder","Your name"]), C("getbyalttext",["find","alt","pixel"]), C("getbytitle",["find","title","matrix-title"]), C("getbytestid",["find","testid","name"]), C("nth",["find","nth","0","button"]),
  C("mousemove",["mouse","move","10","10"],["eval","window.matrixEvents.includes('mousemove')"],"true"), C("mousedown",["mouse","down"],["eval","window.matrixEvents.includes('mousedown')"],"true"), C("mouseup",["mouse","up"],["eval","window.matrixEvents.includes('mouseup')"],"true"), C("wheel",["mouse","wheel","100","0"],["eval","window.matrixEvents.includes('wheel')"],"true"),
  C("viewport",["set","viewport","1024","768"],["eval","innerWidth + 'x' + innerHeight"],"1024x768"), C("device",["set","device","Desktop Chrome"],["eval","innerWidth + 'x' + innerHeight"],"1280x720"), C("geolocation",["set","geo","35.6812","139.7671"],["eval","new Promise(r => navigator.geolocation.getCurrentPosition(p => r(p.coords.latitude.toFixed(4))))"],"35.6812"),
  C("offline",["set","offline","off"],["eval","navigator.onLine"],"true"), C("headers",["set","headers",'{"X-Moat-Matrix":"yes"}']), C("credentials",["set","credentials","matrix","matrix"]), C("emulatemedia",["set","media","dark","reduced-motion"],["eval","matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches"],"true"),
  C("storage_set",["storage","local","set","matrix","stored"],["storage","local","get","matrix"],"stored"), C("storage_get",["storage","local","get","matrix"],undefined,"stored"), C("storage_clear",["storage","local","clear"],["storage","local","get","matrix"],undefined,"stored"),
  C("cookies_set",["cookies","set","matrix","cookie"],["cookies","get"],"matrix"), C("cookies_get",["cookies","get"],undefined,"matrix"),
  C("route",["network","route","**/matrix-route","--body",'{"ok":true}'],["eval","fetch('https://moat.invalid/matrix-route').then(r => r.text())"],"ok"), C("requests",["network","requests"]),
  C("request_detail",["network","request","missing-request-id"],undefined,"x-moat-matrix"), C("unroute",["network","unroute","**/matrix-route"],["eval","fetch('https://moat.invalid/matrix-route').then(() => 'unexpected').catch(() => 'unrouted')"],"unrouted"), C("har_start",["network","har","start"]), C("har_stop",["network","har","stop",join(artifacts,"network.har")],undefined,undefined,undefined,[join(artifacts,"network.har")]),
  C("console",["console"],undefined,"matrix-console"), C("errors",["errors"],undefined,"matrix-page-error"), C("highlight",["highlight","h1"]), C("clipboard",["clipboard","write","matrix-clipboard"],["clipboard","read"],"matrix-clipboard"),
  C("tab_new",["tab","new",fixture],["get","url"],fixture), C("tab_list",["tab","list"],undefined,fixture), C("tab_switch",["tab","switch","0"],["get","url"],fixture), C("tab_close",["tab","close"]),
  C("window_new",["window","new"], ["get","url"], "about:blank"), C("frame",["frame","#frame"],["get","text","#inside"],"frame"), C("mainframe",["frame","main"],["get","text","h1"],"Moat CLI Matrix"), C("dialog",["dialog","accept","matrix"]),
  C("tap",["tap","#button"],["eval","window.matrixEvents.includes('touchstart') && window.matrixEvents.includes('touchend')"],"true"), C("swipe",["swipe","up","100"],["eval","window.matrixEvents.filter(x => x === 'touchstart' || x === 'touchend').length >= 4"],"true"),
  C("trace_start",["trace","start"]), C("trace_stop",["trace","stop",join(artifacts,"trace.zip")],undefined,undefined,undefined,[join(artifacts,"trace.zip")]), C("profiler_start",["profiler","start"]), C("profiler_stop",["profiler","stop",join(artifacts,"profile.json")],undefined,undefined,undefined,[join(artifacts,"profile.json")]),
  C("state_save",["state","save",statePath],undefined,undefined,undefined,[statePath]), C("state_load",["state","load",statePath],["storage","local","get","matrix-state-proof"],"saved"),
  C("batch",["batch"]),
  L("state_list",["state","list"],undefined,state), L("state_show",["state","show",state],undefined,"origins"), L("state_rename",["state","rename",state,"matrix-renamed"],["state","list"],"matrix-renamed",state), L("state_clean",["state","clean","--older-than","30"]), L("state_clear",["state","clear","--all"],["state","list"],undefined,"matrix-renamed"),
  O("diff_snapshot",["diff","snapshot"]), O("diff_screenshot",["diff","screenshot","--baseline",shot,"--output",join(artifacts,"diff.png")],[join(artifacts,"diff.png")]), O("diff_url",["diff","url",`data:text/html,${encodeURIComponent("<title>First</title><h1>First</h1>")}`,`data:text/html,${encodeURIComponent("<title>Different</title><h1>Different</h1>")}`]),
  ...[
    ["a11y",["a11y"]],["auth_save",["auth","save","x"]],["auth_list",["auth","list"]],["auth_show",["auth","show","x"]],["auth_delete",["auth","delete","x"]],["auth_login",["auth","login","x"]],
    ["confirm",["confirm"]],["deny",["deny"]],["device_list",["device","list"]],["inspect",["inspect"]],["launch",["launch"]],["read",["read",fixture]],
    ["react_tree",["react","tree"]],["react_inspect",["react","inspect","1"]],["react_renders_start",["react","renders","start"]],["react_renders_stop",["react","renders","stop"]],["react_suspense",["react","suspense"]],
    ["stream_enable",["stream","enable"]],["stream_disable",["stream","disable"]],["stream_status",["stream","status"]],["vitals",["vitals"]],["webmcp_list",["webmcp","list"]],["webmcp_invoke",["webmcp","invoke","matrix"]],["webmcp_result",["webmcp","result","matrix"]],["webmcp_cancel",["webmcp","cancel","matrix"]],
    ["recording_start",["record","start"]],["recording_stop",["record","stop"]],["recording_restart",["record","restart"]]
  ].map(([a,v])=>U(a as string,v as string[])),
  C("close",["close"]),
];

async function runRaw(argv: string[], json: boolean): Promise<Run> {
  const batch = argv[0] === "batch";
  const proc = Bun.spawn([moat, ...(json ? ["--json"] : []), ...argv], { env: { ...process.env, HOME: home, MOAT_CONTROLLER: controller }, stdin: batch ? "pipe" : undefined, stdout: "pipe", stderr: "pipe" });
  if (batch) { proc.stdin!.write(JSON.stringify([["get","title"],["get","url"]])); proc.stdin!.end(); }
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    proc.exited.then(exit => ({ _tag: "Exited" as const, exit })),
    new Promise<{ _tag: "TimedOut" }>(resolve => {
      timeoutId = setTimeout(() => resolve({ _tag: "TimedOut" }), 60_000);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (completed._tag === "TimedOut") {
    proc.kill(9);
    return { exit: 124, stdout: "", stderr: "command timed out after 60s", jsonValues: 0 };
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const exit = completed.exit;
  const trimmed = stdout.trim();
  try { return { exit, stdout, stderr, value: JSON.parse(trimmed), jsonValues: 1 }; }
  catch { return { exit, stdout, stderr, jsonValues: 0 }; }
}
async function run(argv: string[]): Promise<Run> { return runRaw(argv, true); }

const topLevelResults: TopLevelResult[] = [];
const recordText = async (name: string, argv: string[], expected: RegExp, forbidden?: RegExp) => {
  const r = await runRaw(argv, false);
  const passed = r.exit === 0 && r.stdout.trim().length > 0 && r.stderr.trim().length === 0 && expected.test(r.stdout) && !(forbidden?.test(r.stdout));
  topLevelResults.push({ name, kind:"local_output", argv, exit:r.exit, passed, jsonValues:r.jsonValues, diagnostic:passed ? "" : `expected one stdout text response: stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}` });
};
const recordJson = (name: string, kind: TopLevelKind, argv: string[], r: Run, predicate: (run: Run) => boolean) => {
  const passed = r.jsonValues === 1 && predicate(r);
  topLevelResults.push({ name, kind, argv, exit:r.exit, passed, jsonValues:r.jsonValues, diagnostic:passed ? "" : `JSON contract failed: stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}` });
};

const contractProc = Bun.spawnSync(["python3",join(root,"scripts/cli-command-contract.py")],{stdout:"pipe",stderr:"pipe"});
const contractStdout = new TextDecoder().decode(contractProc.stdout);
let contract: Contract;
try {
  contract = JSON.parse(contractStdout) as Contract;
} catch (error) {
  throw new Error(`CLI contract inventory did not emit JSON: ${String(error)}\n${contractStdout}\n${new TextDecoder().decode(contractProc.stderr)}`);
}
const contractEntries = contract.entries;
const expected = [...new Set(contractEntries.map(entry => entry.action))].sort();
const expectedAvailability = new Map(contractEntries.map(entry => [entry.action, entry.availability]));
const caseNames = cases.map(c => c.action);
const duplicateCases = [...new Set(caseNames.filter((action, index) => caseNames.indexOf(action) !== index))].sort();
const unknownCases = caseNames.filter(action => !expectedAvailability.has(action)).sort();
const caseAvailabilityMismatches = cases
  .filter(c => expectedAvailability.get(c.action) !== c.availability)
  .map(c => ({ action: c.action, declared: c.availability, inventory: expectedAvailability.get(c.action) ?? "missing" }));
const results = [] as Record<string, unknown>[];

// Local output must neither need nor create a session. Exercise every spelling
// because these are separate public top-level parser entries.
await recordText("--help", ["--help"], /moat - remote Chromium/, /agent-browser/);
await recordText("-h", ["-h"], /moat - remote Chromium/, /agent-browser/);
await recordText("help", ["help"], /moat - remote Chromium/, /agent-browser/);
await recordText("--version", ["--version"], /^moat\s+\S+\s*$/);
await recordText("-V", ["-V"], /^moat\s+\S+\s*$/);

const topLevelUnsupportedArgs: Record<string, string[]> = {
  auth: ["auth"],
  confirm: ["confirm"],
  deny: ["deny"],
  device: ["device"],
  inspect: ["inspect"],
  launch: ["launch"],
  record: ["record"],
  stream: ["stream"],
  read: ["read"],
  react: ["react"],
  vitals: ["vitals"],
  "web-vitals": ["web-vitals"],
  a11y: ["a11y"],
  webmcp: ["webmcp"],
  mcp: ["mcp"],
  doctor: ["doctor"],
  skills: ["skills"],
  plugin: ["plugin"],
  plugins: ["plugins"],
  chat: ["chat"],
  dashboard: ["dashboard"],
  install: ["install"],
  profiles: ["profiles"],
  session: ["session"],
  upgrade: ["upgrade"],
};
for (const [name, argv] of Object.entries(topLevelUnsupportedArgs)) {
  if (contract.topLevel[name] !== "stable_unsupported") continue;
  const r = await run(argv);
  recordJson(name, "stable_unsupported", argv, r, value => value.exit !== 0 && value.value?.success === false && value.value?.errorType === "unsupported_in_moat");
}

// Prove all lifecycle aliases against real Controller state without leaking a
// session: init -> status -> use -> disconnect -> absent -> connect -> matrix.
const init = await run(["init"]);
recordJson("init", "controller_session", ["init"], init, r => r.exit === 0 && r.value?.success === true && typeof (r.value?.data as Record<string,unknown> | undefined)?.sessionId === "string");
if (!topLevelResults.at(-1)?.passed) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
const activeSessionId = (init.value?.data as Record<string,unknown> | undefined)?.sessionId;
if (typeof activeSessionId !== "string") throw new Error(`init did not return a session id: ${init.stdout}${init.stderr}`);
const activeStatus = await run(["status"]);
recordJson("status", "local_session", ["status"], activeStatus, r => r.exit === 0 && r.value?.success === true && typeof (r.value?.data as Record<string,unknown> | undefined)?.sessionId === "string");
const use = await run(["use", activeSessionId]);
recordJson("use", "local_session", ["use", activeSessionId], use, r => r.exit === 0 && r.value?.success === true && (r.value?.data as Record<string,unknown> | undefined)?.sessionId === activeSessionId);
const disconnect = await run(["disconnect"]);
recordJson("disconnect", "controller_session", ["disconnect"], disconnect, r => r.exit === 0 && r.value?.success === true);
const absentAfterDisconnect = await run(["status"]);
if (absentAfterDisconnect.exit !== 77 || absentAfterDisconnect.jsonValues !== 1 || absentAfterDisconnect.value?.success !== false) {
  throw new Error(`disconnect left an active session: ${absentAfterDisconnect.stdout}${absentAfterDisconnect.stderr}`);
}
const connect = await run(["connect"]);
recordJson("connect", "controller_session", ["connect"], connect, r => r.exit === 0 && r.value?.success === true && typeof (r.value?.data as Record<string,unknown> | undefined)?.sessionId === "string");
if (!topLevelResults.at(-1)?.passed) throw new Error(`connect failed: ${connect.stdout}${connect.stderr}`);
const destroy = await run(["destroy"]);
recordJson("destroy", "controller_session", ["destroy"], destroy, r => r.exit === 0 && r.value?.success === true);
const reconnectAfterDestroy = await run(["connect"]);
recordJson("connect", "controller_session", ["connect"], reconnectAfterDestroy, r => r.exit === 0 && r.value?.success === true && typeof (r.value?.data as Record<string,unknown> | undefined)?.sessionId === "string");
let initScriptIdentifier: string | undefined;
for (const c of cases) {
  process.stderr.write(`[cli-matrix] ${results.length + 1}/${cases.length} ${c.action}\n`);
  let argv = c.argv;
  if (c.action === "waitfordownload") {
    await run(["eval","setTimeout(() => document.querySelector('#download').click(), 500); true"]);
  }
  if (c.action === "keyboard") await run(["focus","#input"]);
  if (c.action === "offline") {
    const setup = await run(["set","offline","on"]);
    const offline = await run(["eval","navigator.onLine"]);
    if (setup.exit !== 0 || !JSON.stringify(offline.value).includes("false")) {
      throw new Error(`offline fixture setup failed: ${setup.stdout}${offline.stdout}`);
    }
  }
  if (c.action === "dialog") {
    await run(["eval","setTimeout(() => document.querySelector('#prompt').click(), 500); true"]);
  }
  if (c.action === "request_detail") {
    const requestList = await run(["network","requests"]);
    const findId = (value: unknown): string | undefined => {
      if (Array.isArray(value)) for (const item of value) { const found = findId(item); if (found) return found; }
      if (value && typeof value === "object") {
        const record = value as Record<string,unknown>;
        if (typeof record.requestId === "string" && typeof record.url === "string" && record.url.includes("/matrix-route")) return record.requestId;
        for (const item of Object.values(record)) { const found = findId(item); if (found) return found; }
      }
    };
    const requestId = findId(requestList.value);
    if (requestId) argv = ["network","request",requestId];
  }
  if (c.action === "removeinitscript") {
    argv = ["removeinitscript", initScriptIdentifier ?? "missing-matrix-init-script"];
  }
  if (c.action === "har_stop") {
    await run(["eval","fetch('data:text/plain,har-activity').then(r => r.text())"]);
  }
  if (c.action === "console") {
    await run(["eval","console.log('matrix-console-live'); true"]);
    // Console events arrive on the CDP event channel independently from the
    // evaluate response; allow that channel to flush before reading the log.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (c.action === "errors") {
    await run(["eval","setTimeout(() => { throw new Error('matrix-page-error'); }, 0); true"]);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (c.action === "state_save") {
    await run(["storage","local","set","matrix-state-proof","saved"]);
  }
  if (c.action === "state_load") {
    await run(["storage","local","set","matrix-state-proof","changed"]);
  }
  // The first snapshot invocation creates the session baseline. The recorded
  // invocation must compare a changed page, rather than counting baseline
  // creation as a successful diff.
  if (c.action === "diff_snapshot") {
    await run(argv);
    await run(["eval","document.querySelector('h1').textContent='Snapshot Changed'"]);
  }
  if (c.action === "diff_screenshot") {
    await run(["eval","document.body.style.background='rgb(1, 2, 3)'"]);
  }
  const startedAt = performance.now();
  const r = await run(argv);
  const elapsedMs = performance.now() - startedAt;
  if (r.exit === 0 && ["navigate","forward","reload"].includes(c.action)) {
    await run(installFixtureArgv);
  }
  if (r.exit === 0 && c.action === "tab_new") {
    const currentUrl = await run(["get","url"]);
    if (JSON.stringify(currentUrl.value).includes(fixture)) await run(installFixtureArgv);
  }
  if (c.action === "addinitscript" && r.exit === 0) {
    const data = r.value?.data;
    if (data && typeof data === "object" && "identifier" in data && typeof data.identifier === "string") {
      initScriptIdentifier = data.identifier;
    }
  }
  const unsupported = c.availability === "stable_unsupported";
  let effectPassed = unsupported ? r.exit !== 0 && r.value?.errorType === "unsupported_in_moat" : r.exit === 0 && r.value?.success === true;
  let diagnostic = "";
  if (c.action === "pushstate" && effectPassed) {
    const responseData = r.value?.data;
    const responseUrl = responseData && typeof responseData === "object" && "url" in responseData && typeof responseData.url === "string" ? responseData.url : "";
    const urlResult = await run(["get", "url"]);
    const eventsResult = await run(["eval", "window.matrixEvents.filter(x => x === 'popstate' || x === 'navigate').join(',')"]);
    const sameUrl = await run(["pushstate", "/matrix-pushstate"]);
    const sameEventsResult = await run(["eval", "window.matrixEvents.filter(x => x === 'popstate' || x === 'navigate').join(',')"]);
    const fallbackEvents = JSON.stringify(eventsResult.value);
    const sameEvents = JSON.stringify(sameEventsResult.value);
    const fallbackCheck = c.verify ? await run(c.verify) : undefined;
    const fallbackCheckRendered = fallbackCheck ? JSON.stringify(fallbackCheck.value) : "";
    const fallbackPassed = responseUrl.includes("/matrix-pushstate")
      && urlResult.exit === 0
      && eventsResult.exit === 0
      && sameUrl.exit === 0
      && sameEventsResult.exit === 0
      && fallbackEvents.includes("popstate,navigate")
      && sameEvents.includes("popstate,navigate")
      && !sameEvents.includes("popstate,navigate,popstate")
      && (!fallbackCheck
        || (fallbackCheck.exit === 0
          && fallbackCheck.value?.success === true
          && (!c.contains || fallbackCheckRendered.includes(c.contains))
          && (!c.notContains || !fallbackCheckRendered.includes(c.notContains))));

    const routerOpen = await run(["open", new URL("/router", fixture).toString()]);
    const routerRestore = routerOpen.exit === 0 ? await run(installFixtureArgv) : routerOpen;
    const routerPush = routerRestore.exit === 0 ? await run(["pushstate", "/routed"]) : routerRestore;
    const routeResult = routerPush.exit === 0 ? await run(["get", "text", "#route"]) : routerPush;
    const routerEvents = routerPush.exit === 0
      ? await run(["eval", "window.matrixEvents.filter(x => x === 'popstate' || x === 'navigate').join(',')"])
      : routerPush;
    const routerPassed = routerPush.exit === 0
      && routeResult.exit === 0
      && routerEvents.exit === 0
      && JSON.stringify(routeResult.value).includes("router:/routed")
      && !JSON.stringify(routerEvents.value).includes("popstate,navigate");
    effectPassed = fallbackPassed && routerPassed;
    if (!effectPassed) {
      diagnostic = `pushstate effect failed: response=${JSON.stringify(responseData)} url=${urlResult.stdout} events=${eventsResult.stdout} same=${sameEventsResult.stdout} fallback=${fallbackCheck?.stdout ?? ""} route=${routeResult.stdout} routerEvents=${JSON.stringify(routerEvents.value)}`;
    }
  }
  if (effectPassed && c.verify && c.action !== "pushstate") {
    const check = await run(c.verify); const rendered = JSON.stringify(check.value);
    effectPassed = check.exit === 0 && check.value?.success === true && (!c.contains || rendered.includes(c.contains)) && (!c.notContains || !rendered.includes(c.notContains));
    if (!effectPassed) diagnostic = `effect verifier failed: ${check.stdout}${check.stderr}`;
  } else if (effectPassed && c.contains) {
    effectPassed = JSON.stringify(r.value).includes(c.contains);
    if (!effectPassed) diagnostic = `response missing ${c.contains}`;
  }
  if (effectPassed && c.action === "addinitscript") {
    const data = r.value?.data;
    const responseValid = data && typeof data === "object" && "added" in data && data.added === true && "identifier" in data && typeof data.identifier === "string";
    const before = await run(["eval", "document.body?.dataset.moatMatrixInit ?? 'undefined'"]);
    const reload = await run(["reload"]);
    const restore = reload.exit === 0 ? await run(installFixtureArgv) : reload;
    const after = restore.exit === 0 ? await run(["eval", "document.body?.dataset.moatMatrixInit ?? 'undefined'"]) : restore;
    effectPassed = responseValid && before.exit === 0 && JSON.stringify(before.value).includes("undefined") && reload.exit === 0 && after.exit === 0 && JSON.stringify(after.value).includes("active");
    if (!effectPassed) diagnostic = `addinitscript lifecycle failed: response=${JSON.stringify(data)} before=${before.stdout} reload=${reload.stdout} after=${after.stdout}`;
  }
  if (effectPassed && c.action === "removeinitscript") {
    const data = r.value?.data;
    const responseValid = data && typeof data === "object" && "removed" in data && data.removed === true && "identifier" in data && data.identifier === initScriptIdentifier;
    const reload = await run(["reload"]);
    const restore = reload.exit === 0 ? await run(installFixtureArgv) : reload;
    const after = restore.exit === 0 ? await run(["eval", "document.body?.dataset.moatMatrixInit ?? 'undefined'"]) : restore;
    effectPassed = responseValid && typeof initScriptIdentifier === "string" && reload.exit === 0 && after.exit === 0 && JSON.stringify(after.value).includes("undefined");
    if (!effectPassed) diagnostic = `removeinitscript lifecycle failed: response=${JSON.stringify(data)} reload=${reload.stdout} after=${after.stdout}`;
  }
  if (effectPassed && c.artifacts) {
    for (const path of c.artifacts) {
      try {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size === 0) throw new Error("empty or not a file");
      } catch (error) {
        effectPassed = false;
        diagnostic = `artifact assertion failed for ${path}: ${String(error)}`;
      }
    }
  }
  if (effectPassed && c.action === "batch") {
    const rendered = JSON.stringify(r.value);
    effectPassed = rendered.includes("Moat CLI Matrix") && rendered.includes(fixture);
    if (!effectPassed) diagnostic = `batch did not return both command results: ${r.stdout}`;
  }
  if (effectPassed && c.action === "wait") {
    effectPassed = elapsedMs >= 5;
    if (!effectPassed) diagnostic = `wait returned too early after ${elapsedMs.toFixed(1)}ms`;
  }
  if (effectPassed && c.action === "request_detail" && argv.includes("missing-request-id")) {
    effectPassed = false;
    diagnostic = "request fixture produced no real request id";
  }
  if (effectPassed && c.action === "diff_snapshot") {
    effectPassed = JSON.stringify(r.value).includes("Snapshot Changed");
    if (!effectPassed) diagnostic = `snapshot diff did not expose the changed content: ${r.stdout}`;
  }
  if (effectPassed && c.action === "diff_screenshot") {
    try {
      const metadata = await stat(join(artifacts,"diff.png"));
      effectPassed = metadata.size > 0;
    } catch (error) {
      effectPassed = false; diagnostic = `screenshot diff artifact missing: ${String(error)}`;
    }
  }
  if (effectPassed && c.action === "diff_url") {
    const rendered = JSON.stringify(r.value);
    effectPassed = rendered.includes("First") && rendered.includes("Different");
    if (!effectPassed) diagnostic = `URL diff did not contain both distinct documents: ${r.stdout}`;
  }
  if (r.jsonValues !== 1) diagnostic = `stdout is not exactly one JSON value: ${r.stdout}`;
  results.push({ name:c.action, parserAction:c.action, availability:c.availability, argv, exit:r.exit, success:r.value?.success === true, error:r.value?.error, errorType:r.value?.errorType, jsonValues:r.jsonValues, elapsedMs, effectAssertion:c.verify ?? c.artifacts ?? (unsupported ? ["stable unsupported error"] : ["successful observable response"]), effectPassed, internalDiagnostic:diagnostic || r.stderr.trim() });
  // `window new` intentionally creates an about:blank page. Restore the
  // deterministic fixture only after its blank-page contract was asserted.
  if (c.action === "window_new" && r.exit === 0) {
    const restore = await run(["open", fixture]);
    if (restore.exit === 0) await run(installFixtureArgv);
  }
}
const covered = [...new Set(cases.map(c=>c.action))].sort();
const missing = expected.filter(a=>!covered.includes(a));
const failed = results.filter(r=>r.jsonValues !== 1 || (r.availability !== "stable_unsupported" && !r.success) || (r.availability === "stable_unsupported" && (r.exit === 0 || r.errorType !== "unsupported_in_moat")));
const noOp = results.filter(r=>r.effectPassed !== true);
// `close` is a wire action; `close-session` is the top-level lifecycle alias
// that must destroy the Controller container and clear ~/.moat/session.
const reconnectForCloseSession = await run(["connect"]);
if (reconnectForCloseSession.exit !== 0 || reconnectForCloseSession.value?.success !== true) {
  throw new Error(`could not create close-session verification session: ${reconnectForCloseSession.stdout}${reconnectForCloseSession.stderr}`);
}
const closeSession = await run(["close-session"]);
recordJson("close-session", "controller_session", ["close-session"], closeSession, r => r.exit === 0 && r.value?.success === true);
const status = await run(["status"]);
const isolationPassed = status.exit === 77 && status.jsonValues === 1 && status.value?.success === false;
const expectedTopLevel = Object.keys(contract.topLevel).sort();
const coveredTopLevel = [...new Set(topLevelResults.map(result => result.name))].sort();
const topLevelMissing = expectedTopLevel.filter(name => !coveredTopLevel.includes(name));
const topLevelFailed = topLevelResults.filter(result => !result.passed).map(result => result.name);
const inventoryGaps = Object.entries(contract.gaps).flatMap(([name, values]) => values.map(value => `${name}: ${value}`));
const report = {
  generatedAt:new Date().toISOString(),
  controller,
  moat,
  contractCounts: contract.counts,
  actionInventory: contractEntries,
  expectedActions:expected.length,
  coveredActions:covered.length,
  cases:results.length,
  missing,
  unknownCases,
  duplicateCases,
  caseAvailabilityMismatches,
  failed:failed.map(r=>r.name),
  noOp:noOp.map(r=>r.name),
  internalDiagnostics:results.filter(r=>r.internalDiagnostic).map(r=>({name:r.name, diagnostic:r.internalDiagnostic})),
  inventoryGaps,
  expectedTopLevel:expectedTopLevel.length,
  coveredTopLevel:coveredTopLevel.length,
  topLevelMissing,
  topLevelFailed,
  topLevelResults,
  isolationPassed,
  results,
};
await writeFile(resultPath, JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report));
if (ownHome) await rm(home,{recursive:true,force:true});
if (
  inventoryGaps.length
  || missing.length
  || unknownCases.length
  || duplicateCases.length
  || caseAvailabilityMismatches.length
  || failed.length
  || noOp.length
  || report.internalDiagnostics.length
  || topLevelMissing.length
  || topLevelFailed.length
  || !isolationPassed
) process.exit(1);
