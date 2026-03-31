import type { IncomingMessage, ServerResponse } from "node:http";

const NEKO_PREFIX = "/neko/";

export function isNekoRequest(req: IncomingMessage): boolean {
  return req.url?.startsWith(NEKO_PREFIX) ?? false;
}

export async function handleNekoProxy(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "";
  const parts = url.slice(NEKO_PREFIX.length).split("/");
  const profileName = parts[0];
  const rest = "/" + parts.slice(1).join("/");

  if (!profileName) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Missing profile name" }));
    return;
  }

  const nekoHost = process.env["MOAT_NEKO_HOST"] ?? "127.0.0.1";
  const nekoPort = process.env["MOAT_NEKO_PORT"] ?? "9080";
  const targetUrl = `http://${nekoHost}:${nekoPort}${rest}`;

  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && key !== "host") {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    const reqBody = req.method !== "GET" && req.method !== "HEAD"
      ? new Uint8Array(await readBody(req))
      : null;

    const proxyRes = await fetch(targetUrl, {
      method: req.method ?? "GET",
      headers,
      body: reqBody,
    });

    res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers));
    const resBody = new Uint8Array(await proxyRes.arrayBuffer());
    res.end(resBody);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: "neko proxy error", message: String(err) }));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
