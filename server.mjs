import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export const ORIGINS = Object.freeze({
  host: Object.freeze({ role: "host", port: 8000, root: resolve(projectRoot, "public/host") }),
  task: Object.freeze({ role: "task", port: 8001, root: resolve(projectRoot, "public/task") }),
  privacy: Object.freeze({ role: "privacy", port: 8002, root: resolve(projectRoot, "public/privacy") })
});

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
});

const permissionsPolicy = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "clipboard-read=()",
  "clipboard-write=()"
].join(", ");

const contentSecurityPolicies = Object.freeze({
  host: [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'none'",
    "connect-src 'none'",
    "frame-src http: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "),
  task: [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors http://127.0.0.1:8000"
  ].join("; "),
  privacy: [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors http://127.0.0.1:8000"
  ].join("; ")
});

export function securityHeaders(role) {
  if (!(role in contentSecurityPolicies)) {
    throw new TypeError(`Unknown origin role: ${role}`);
  }

  return Object.freeze({
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicies[role],
    "Permissions-Policy": permissionsPolicy,
    "Referrer-Policy": "strict-origin",
    "X-Content-Type-Options": "nosniff"
  });
}

function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://local.invalid").pathname);
  } catch {
    return null;
  }

  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) return null;

  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function sendText(response, status, body, headers) {
  response.writeHead(status, {
    ...headers,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function createOriginServer(role, options = {}) {
  const config = ORIGINS[role];
  if (!config) throw new TypeError(`Unknown origin role: ${role}`);

  const root = options.root ?? config.root;
  const headers = securityHeaders(role);

  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed\n", headers);
      return;
    }

    const filePath = resolveRequestPath(root, request.url ?? "/");
    if (!filePath) {
      sendText(response, 400, "Bad request\n", headers);
      return;
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      sendText(response, 404, "Not found\n", headers);
      return;
    }

    if (!fileStat.isFile()) {
      sendText(response, 404, "Not found\n", headers);
      return;
    }

    const contentType = contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": fileStat.size
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  });
}

export async function startServers(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const ports = options.ports ?? {};
  const running = [];

  try {
    for (const role of Object.keys(ORIGINS)) {
      const server = createOriginServer(role);
      const port = ports[role] ?? ORIGINS[role].port;
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      running.push({ role, server });
    }
  } catch (error) {
    await Promise.all(running.map(({ server }) => new Promise((resolveClose) => server.close(resolveClose))));
    throw error;
  }

  return running;
}

export async function stopServers(running) {
  await Promise.all(running.map(({ server }) => new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  })));
}

async function main() {
  const running = await startServers();
  for (const { role, server } of running) {
    const address = server.address();
    console.log(`${role.padEnd(7)} http://127.0.0.1:${address.port}`);
  }
  console.log("\nOpen http://127.0.0.1:8000");

  const shutdown = async () => {
    await stopServers(running);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
