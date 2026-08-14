import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  ORIGINS,
  WEATHER_SERVICE,
  createOriginServer,
  createWeatherService,
  securityHeaders
} from "../server.mjs";

test("each configured origin has its own HTML entrypoint", async () => {
  const roots = new Set();
  for (const role of ["host", "task", "privacy"]) {
    const config = ORIGINS[role];
    roots.add(config.root);
    assert.equal((await stat(`${config.root}/index.html`)).isFile(), true);
    assert.match(await readFile(`${config.root}/index.html`, "utf8"), /<!doctype html>/i);
  }
  assert.equal(roots.size, 3);
});

test("component frames stay opaque and the task page exposes run history", async () => {
  const hostHtml = await readFile(`${ORIGINS.host.root}/index.html`, "utf8");
  const taskHtml = await readFile(`${ORIGINS.task.root}/index.html`, "utf8");
  assert.equal((hostHtml.match(/sandbox="allow-scripts"/g) ?? []).length, 2);
  assert.doesNotMatch(hostHtml, /allow-same-origin/);
  assert.match(taskHtml, /id="activity-log"/);
  assert.match(taskHtml, /every five seconds/i);
});

test("the host cannot be framed and restricts frames and action networking", () => {
  const headers = securityHeaders("host");
  const csp = headers["Content-Security-Policy"];
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:8001 http:\/\/127\.0\.0\.1:8002/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:8003/);
  assert.match(csp, /object-src 'none'/);
});

test("component origins can only be framed by the fixed host origin", () => {
  for (const role of ["task", "privacy"]) {
    const headers = securityHeaders(role);
    const csp = headers["Content-Security-Policy"];
    assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:8000/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.equal(headers["Access-Control-Allow-Origin"], "*");
  }
});

test("component origins expose only their required SDK source modules", async (context) => {
  for (const [role, assets] of Object.entries({
    host: {
      public: ["/action-sdk/index.js", "/action-example/weather.js"],
      private: ["/action-sdk/index.test.js", "/action-example/weather.test.js"]
    },
    task: {
      public: ["/runtime-sdk/index.js", "/task-example/index.js", "/task-example/task.js"],
      private: ["/runtime-sdk/index.test.js", "/task-example/task.test.js"]
    },
    privacy: {
      public: ["/vault-sdk/index.js"],
      private: ["/vault-sdk/index.test.js"]
    }
  })) {
    await context.test(role, async () => {
      const server = createOriginServer(role);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const address = server.address();
        for (const path of assets.public) {
          const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
          assert.equal(response.status, 200);
          assert.match(response.headers.get("content-type"), /text\/javascript/);
        }
        for (const path of assets.private) {
          const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
          assert.equal(response.status, 404);
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

test("the weather service is origin-bound and returns deterministic bounded JSON", async () => {
  const server = createWeatherService({ now: () => new Date("2026-08-14T12:00:00.000Z") });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/weather?city=Vancouver`;
    const denied = await fetch(endpoint);
    assert.equal(denied.status, 403);

    const response = await fetch(endpoint, {
      headers: { Origin: WEATHER_SERVICE.allowedOrigin }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), WEATHER_SERVICE.allowedOrigin);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      city: "Vancouver",
      temperatureC: 6.5,
      humidity: 52,
      condition: "snow",
      observedAt: "2026-08-14T12:00:00.000Z"
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the launcher creates one initially-stopped server per role", () => {
  for (const role of ["host", "task", "privacy"]) {
    const server = createOriginServer(role);
    assert.equal(server.listening, false);
    server.close();
  }
  const weather = createWeatherService();
  assert.equal(weather.listening, false);
  weather.close();
});
