#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const USERNAME = process.env.MOAT_FIXTURE_USERNAME;
const PASSWORD = process.env.MOAT_FIXTURE_PASSWORD;
const IDENTITY = process.env.MOAT_FIXTURE_IDENTITY || USERNAME;
const MAX_BODY_BYTES = 16 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  console.error("PORT must be an integer between 1 and 65535");
  process.exit(64);
}
if (!USERNAME || !PASSWORD) {
  console.error("MOAT_FIXTURE_USERNAME and MOAT_FIXTURE_PASSWORD are required");
  process.exit(64);
}

// The token is deterministic for this test fixture, but a session still has to
// be created by a successful form POST. This prevents an empty profile from
// becoming authenticated merely because it knows a cookie value.
const sessionToken = createHash("sha256")
  .update(`${USERNAME}\u0000${PASSWORD}`, "utf8")
  .digest("hex");
const sessions = new Map();
const observations = {
  loginCount: 0,
  failedLoginCount: 0,
  authenticatedPrivateCount: 0,
  loggedOutPrivateCount: 0,
  lastAuthenticatedUser: null,
};

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function sameSecret(actual, expected) {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function cookieValue(request, name) {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function currentSession(request) {
  const token = cookieValue(request, "moat_fixture_session");
  return token ? sessions.get(token) ?? null : null;
}

function response(res, status, headers, body = "") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

function htmlResponse(res, status, body, headers = {}) {
  response(res, status, { "Content-Type": "text/html; charset=utf-8", ...headers }, body);
}

function jsonResponse(res, status, value, headers = {}) {
  response(res, status, { "Content-Type": "application/json; charset=utf-8", ...headers }, JSON.stringify(value));
}

function redirect(res, location, headers = {}) {
  response(res, 303, { Location: location, ...headers });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversized = false;
    const chunks = [];
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else oversized = true;
    });
    request.once("end", () => {
      if (oversized) reject(new RangeError("request body exceeds the fixture limit"));
      else resolve(chunks.join(""));
    });
    request.once("error", reject);
  });
}

function loginPage(error = "") {
  const errorMarkup = error
    ? `<p id="login-error" role="alert">${htmlEscape(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clean Container Fixture Login</title></head>
<body data-fixture-page="login">
  <main>
    <h1>Clean Container Fixture</h1>
    <p id="login-instructions">Sign in with the deterministic test account.</p>
    ${errorMarkup}
    <form id="login-form" method="post" action="/login">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button id="login" type="submit">Login</button>
    </form>
  </main>
</body>
</html>`;
}

function privatePage(session) {
  if (session) {
    const identity = htmlEscape(session.identity);
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clean Container Fixture Private</title></head>
<body data-fixture-page="private" data-authenticated="true">
  <main>
    <h1 id="auth-state" data-auth-state="authenticated" data-authenticated-user="${identity}">Authenticated</h1>
    <p id="user-identity">Signed in as <span id="authenticated-user">${identity}</span></p>
    <p id="private-proof">This private page requires the fixture session cookie.</p>
    <a id="logout" href="/logout">Log out</a>
  </main>
</body>
</html>`;
  }
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clean Container Fixture Unauthorized</title></head>
<body data-fixture-page="private" data-authenticated="false">
  <main>
    <h1 id="auth-state" data-auth-state="logged-out" data-authenticated-user="">Not authorized</h1>
    <p id="private-proof">No active fixture session is present in this browser profile.</p>
    <a id="login-link" href="/login">Log in</a>
  </main>
</body>
</html>`;
}

function probePage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clean Container Fixture Probe</title></head>
<body data-fixture-page="probe" data-init="undefined" data-marker="" data-events="">
  <main>
    <h1>Probe</h1>
    <label for="input">Name</label><input id="input" value="old">
    <div id="editable" contenteditable="true">Editable</div>
    <input id="alt" alt="Alt"><input id="title" title="Title">
    <label for="notes">Notes</label><textarea id="notes" placeholder="Notes" data-testid="notes">Body</textarea>
    <label for="check">Check</label><input id="check" type="checkbox" data-testid="check">
    <a href="/target">Target</a>
  </main>
  <script>
    const inputEvents = [];
    const input = document.querySelector("#input");
    input.addEventListener("input", event => {
      inputEvents.push({ time: performance.now(), value: event.target.value });
      document.body.dataset.inputTimes = JSON.stringify(inputEvents);
    });
    document.querySelector("#notes").addEventListener("mouseover", () => {
      document.body.dataset.hovered = "yes";
    });
    document.body.dataset.init = String(window.__moat_init ?? "undefined");
    document.body.dataset.marker = "kept";
    window.addEventListener("popstate", () => { document.body.dataset.events += "popstate,"; });
    window.addEventListener("navigate", () => { document.body.dataset.events += "navigate,"; });
  </script>
</body>
</html>`;
}

function routerObservationScript() {
  return `
    document.body.dataset.init = String(window.__moat_init ?? "undefined");
    document.body.dataset.marker = "kept";
    document.body.dataset.events = "";
    window.addEventListener("popstate", () => { document.body.dataset.events += "popstate,"; });
    window.addEventListener("navigate", () => { document.body.dataset.events += "navigate,"; });
  `;
}

function routerPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clean Container Fixture Router</title></head>
<body data-fixture-page="router" data-init="undefined" data-marker="" data-events="">
  <main>
    <h1>Router Fixture</h1>
    <p id="route">initial</p>
    <output id="router-events" data-router-events="0">0</output>
  </main>
  <script>
    window.__fixtureRouterEvents = [];
    window.__fixtureEvents = window.__fixtureRouterEvents;
    window.next = {
      router: {
        push(url) {
          const requested = String(url);
          const absolute = new URL(requested, window.location.href);
          history.pushState(null, "", absolute.href);
          document.querySelector("#route").textContent = "router:" + requested;
          const event = { type: "router.push", url: requested, href: window.location.href };
          window.__fixtureRouterEvents.push(event);
          const count = window.__fixtureRouterEvents.length;
          const output = document.querySelector("#router-events");
          output.textContent = String(count);
          output.dataset.routerEvents = String(count);
          window.dispatchEvent(new CustomEvent("fixture:navigate", { detail: event }));
          return window.location.href;
        }
      }
    };
    ${routerObservationScript()}
  </script>
</body>
</html>`;
}

async function handle(request, res) {
  const url = new URL(request.url ?? "/", "http://clean-container-fixture");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    jsonResponse(res, 200, { ok: true, service: "clean-container-fixture" });
    return;
  }

  if (method === "GET" && url.pathname === "/observations") {
    jsonResponse(res, 200, {
      ok: true,
      ...observations,
      activeSessions: sessions.size,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    redirect(res, "/login");
    return;
  }

  if (method === "GET" && url.pathname === "/login") {
    htmlResponse(res, 200, loginPage());
    return;
  }

  if (method === "POST" && url.pathname === "/login") {
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof RangeError) {
        response(res, 413, { "Content-Type": "text/plain; charset=utf-8" }, "request body too large");
        return;
      }
      throw error;
    }
    const form = new URLSearchParams(body);
    const suppliedUsername = form.get("username") ?? "";
    const suppliedPassword = form.get("password") ?? "";
    if (!sameSecret(suppliedUsername, USERNAME) || !sameSecret(suppliedPassword, PASSWORD)) {
      observations.failedLoginCount += 1;
      htmlResponse(res, 401, loginPage("Invalid test credentials"));
      return;
    }
    sessions.set(sessionToken, { identity: IDENTITY, createdAt: Date.now() });
    observations.loginCount += 1;
    observations.lastAuthenticatedUser = IDENTITY;
    const cookieExpires = new Date(Date.now() + 86_400_000).toUTCString();
    const cookie = `moat_fixture_session=${sessionToken}; Max-Age=86400; Expires=${cookieExpires}; Path=/; HttpOnly; SameSite=Lax`;
    redirect(res, "/private", {
      "Set-Cookie": cookie,
      "X-Fixture-Auth": "authenticated",
      "X-Fixture-User": IDENTITY,
    });
    return;
  }

  if ((method === "GET" || method === "POST") && url.pathname === "/logout") {
    const token = cookieValue(request, "moat_fixture_session");
    if (token) sessions.delete(token);
    response(res, 303, {
      Location: "/login",
      "Set-Cookie": "moat_fixture_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      "X-Fixture-Auth": "logged-out",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/private") {
    const session = currentSession(request);
    if (session) {
      observations.authenticatedPrivateCount += 1;
      response(res, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Fixture-Auth": "authenticated",
        "X-Fixture-User": session.identity,
      }, privatePage(session));
    } else {
      observations.loggedOutPrivateCount += 1;
      response(res, 401, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Fixture-Auth": "logged-out",
      }, privatePage(null));
    }
    return;
  }

  if (method === "GET" && url.pathname === "/json") {
    jsonResponse(res, 200, { original: true });
    return;
  }

  if (method === "GET" && url.pathname === "/binary") {
    response(res, 200, { "Content-Type": "application/octet-stream" }, Buffer.from([0, 255, 128, 254]));
    return;
  }

  if (method === "GET" && url.pathname === "/probe") {
    htmlResponse(res, 200, probePage());
    return;
  }

  if (method === "GET" && url.pathname === "/router") {
    htmlResponse(res, 200, routerPage());
    return;
  }

  response(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found");
}

const server = createServer((request, res) => {
  handle(request, res).catch((error) => {
    // Never include request bodies or credential material in logs.
    const message = error instanceof Error ? error.message : "unknown fixture error";
    console.error(`fixture request failed: ${message}`);
    if (!res.headersSent) response(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "fixture request failed");
    else res.destroy();
  });
});

function stop() {
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`clean-container fixture listening on ${PORT}`);
});
