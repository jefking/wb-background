import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const sourceAssets = Object.freeze({
  host: Object.freeze({
    "/action-sdk/index.js": resolve(projectRoot, "src/action-sdk/index.js"),
    "/action-example/weather.js": resolve(projectRoot, "src/action-example/weather.js")
  }),
  task: Object.freeze({
    "/runtime-sdk/index.js": resolve(projectRoot, "src/runtime-sdk/index.js"),
    "/task-example/index.js": resolve(projectRoot, "src/task-example/index.js"),
    "/task-example/task.js": resolve(projectRoot, "src/task-example/task.js")
  }),
  privacy: Object.freeze({
    "/vault-sdk/index.js": resolve(projectRoot, "src/vault-sdk/index.js")
  })
});

export const ORIGINS = Object.freeze({
  host: Object.freeze({ role: "host", port: 8000, root: resolve(projectRoot, "public/host") }),
  task: Object.freeze({ role: "task", port: 8001, root: resolve(projectRoot, "public/task") }),
  privacy: Object.freeze({ role: "privacy", port: 8002, root: resolve(projectRoot, "public/privacy") })
});

export const WEATHER_SERVICE = Object.freeze({
  role: "weather",
  port: 8003,
  origin: "http://127.0.0.1:8003",
  allowedOrigin: "http://127.0.0.1:8000"
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
    `connect-src ${WEATHER_SERVICE.origin}`,
    "frame-src http://127.0.0.1:8001 http://127.0.0.1:8002",
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

  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicies[role],
    "Permissions-Policy": permissionsPolicy,
    "Referrer-Policy": "strict-origin",
    "X-Content-Type-Options": "nosniff"
  };

  // A sandboxed privacy frame has an opaque origin. CORS permits its ES module
  // graph to load without weakening the iframe's same-origin isolation.
  if (role === "privacy") headers["Access-Control-Allow-Origin"] = "*";
  return Object.freeze(headers);
}

function resolveRequestPath(root, requestUrl, assets = {}) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://local.invalid").pathname);
  } catch {
    return null;
  }

  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) return null;

  if (Object.hasOwn(assets, pathname)) return assets[pathname];

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
  const assets = options.assets ?? sourceAssets[role];
  const headers = securityHeaders(role);

  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed\n", headers);
      return;
    }

    const filePath = resolveRequestPath(root, request.url ?? "/", assets);
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

function weatherForCity(city, now = () => new Date()) {
  let hash = 2_166_136_261;
  for (const character of city.toLocaleLowerCase("en-US")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const conditions = ["clear", "cloudy", "fog", "rain", "snow", "wind"];
  return Object.freeze({
    city,
    temperatureC: Math.round((((hash % 451) - 100) / 10) * 10) / 10,
    humidity: 30 + (hash % 66),
    condition: conditions[hash % conditions.length],
    observedAt: now().toISOString()
  });
}

/** A deterministic local API used to demonstrate a constrained Host action. */
export function createWeatherService(options = {}) {
  const allowedOrigin = options.allowedOrigin ?? WEATHER_SERVICE.allowedOrigin;
  const now = options.now ?? (() => new Date());

  return createServer((request, response) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff"
    };
    if (request.headers.origin !== allowedOrigin) {
      sendText(response, 403, "Forbidden origin\n", {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendText(response, 405, "Method not allowed\n", corsHeaders);
      return;
    }

    let url;
    try {
      url = new URL(request.url ?? "/", WEATHER_SERVICE.origin);
    } catch {
      sendText(response, 400, "Bad request\n", corsHeaders);
      return;
    }
    const queryKeys = [...url.searchParams.keys()];
    const city = url.searchParams.get("city")?.normalize("NFC").trim() ?? "";
    if (url.pathname !== "/weather"
      || queryKeys.length !== 1
      || queryKeys[0] !== "city"
      || city.length === 0
      || city.length > 80
      || /[\u0000-\u001f\u007f]/.test(city)) {
      sendText(response, 400, "Invalid weather request\n", corsHeaders);
      return;
    }

    const body = JSON.stringify(weatherForCity(city, now));
    response.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body)
    });
    response.end(body);
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
    const weather = createWeatherService();
    const weatherPort = ports.weather ?? WEATHER_SERVICE.port;
    await new Promise((resolveListen, rejectListen) => {
      weather.once("error", rejectListen);
      weather.listen(weatherPort, host, () => {
        weather.off("error", rejectListen);
        resolveListen();
      });
    });
    running.push({ role: WEATHER_SERVICE.role, server: weather });
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
