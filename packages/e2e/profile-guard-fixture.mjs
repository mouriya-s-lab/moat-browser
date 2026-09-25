// Disposable auth origin: only /login issues a cookie; /me only validates it.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const sessions = new Set();
let sealed = false;

createServer((request, response) => {
  if (request.url === "/seal" && request.method === "POST" &&
      (request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::ffff:127.0.0.1")) {
    sealed = true;
    response.writeHead(204).end();
    return;
  }

  let status, body;
  if (request.url === "/login" && request.method === "GET") {
    if (sealed) {
      console.log("DENIED_LOGIN after source shutdown");
      status = 403;
      body = '<h1 id="login-sealed">login sealed</h1>';
    } else {
      const session = randomBytes(24).toString("base64url");
      sessions.add(session);
      console.log(`ISSUED session=${session}`);
      response.setHeader("Set-Cookie", `moat_session=${session}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`);
      status = 200;
      body = `<h1 id="session">${session}</h1>`;
    }
  } else if (request.url === "/me" && request.method === "GET") {
    const cookie = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("moat_session="));
    const session = cookie?.slice("moat_session=".length);
    if (session && sessions.has(session)) {
      status = 200;
      body = `<h1 id="session">${session}</h1>`;
    } else {
      status = 401;
      body = '<h1 id="unauthenticated">unauthenticated</h1>';
    }
  } else {
    status = 404;
    body = "not found";
  }
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(body);
}).listen(8000, "0.0.0.0");
