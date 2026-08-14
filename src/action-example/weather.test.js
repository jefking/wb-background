import assert from "node:assert/strict";
import test from "node:test";

import { ActionRegistry } from "../action-sdk/index.js";
import { createWeatherAction } from "./weather.js";

test("weather action keeps weather.city out of the sanitized task result", async () => {
  let captured;
  const fetchFn = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      city: "Vancouver",
      temperatureC: 12.4,
      humidity: 73,
      condition: "rain",
      observedAt: "2026-08-14T12:00:00.000Z"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const registry = new ActionRegistry();
  registry.register(createWeatherAction({ fetchFn }));

  const result = await registry.execute("weather.current", {
    input: {},
    values: { city: "Vancouver" }
  });
  assert.deepEqual({ ...result }, {
    temperatureC: 12.4,
    humidity: 73,
    condition: "rain",
    observedAt: "2026-08-14T12:00:00.000Z"
  });
  assert.equal(Object.hasOwn(result, "city"), false);
  assert.equal(new URL(captured.url).origin, "http://127.0.0.1:8003");
  assert.equal(new URL(captured.url).searchParams.get("city"), "Vancouver");
  assert.equal(captured.init.redirect, "error");
});

test("weather action accepts no task-controlled URL or input", async () => {
  const registry = new ActionRegistry();
  registry.register(createWeatherAction({ fetchFn: async () => {
    throw new Error("should not fetch");
  } }));

  await assert.rejects(
    registry.execute("weather.current", {
      input: { url: "https://evil.example" },
      values: { city: "Vancouver" }
    }),
    (error) => error.code === "invalid_input"
  );
  await assert.rejects(
    registry.execute("weather.current", { input: {}, values: { city: "" } }),
    (error) => error.code === "invalid_vault_value"
  );
});
