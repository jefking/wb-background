import assert from "node:assert/strict";
import test from "node:test";

import { ActionError, ActionRegistry, cloneBoundedJson, fetchJson } from "./index.js";

function exampleDefinition(overrides = {}) {
  return {
    id: "example.read",
    title: "Read example",
    description: "Read one constrained example value.",
    destination: { origin: "https://api.example", method: "GET", path: "/value" },
    requiredEntries: [{ slot: "token", key: "api.token", kinds: ["secret"] }],
    validateInput(input) {
      if (Object.keys(input).length !== 0) throw new ActionError("invalid_input", "No input allowed.");
      return input;
    },
    async execute({ values }) {
      return { tokenLength: values.token.length };
    },
    ...overrides
  };
}

test("cloneBoundedJson strips prototypes, freezes data, and rejects unsafe values", () => {
  const clone = cloneBoundedJson({ nested: { value: 1 }, list: [true, "ok"] });
  assert.equal(Object.getPrototypeOf(clone), null);
  assert.equal(Object.getPrototypeOf(clone.nested), null);
  assert.equal(Object.isFrozen(clone), true);
  assert.equal(Object.isFrozen(clone.list), true);
  assert.equal(clone.nested.value, 1);

  assert.throws(
    () => cloneBoundedJson({ value: Number.POSITIVE_INFINITY }),
    (error) => error.code === "invalid_input"
  );
  assert.throws(
    () => cloneBoundedJson({ value: new Date() }),
    (error) => error.code === "invalid_input"
  );
  const unsafe = Object.create(null);
  unsafe.__proto__ = "bad";
  assert.throws(() => cloneBoundedJson(unsafe), (error) => error.code === "invalid_input");
});

test("ActionRegistry owns definitions, validates inputs, and bounds outputs", async () => {
  const registry = new ActionRegistry();
  assert.deepEqual(registry.register(exampleDefinition()), {
    id: "example.read",
    title: "Read example",
    description: "Read one constrained example value.",
    destination: { origin: "https://api.example", method: "GET", path: "/value" },
    requiredEntries: [{ slot: "token", key: "api.token", kinds: ["secret"] }]
  });
  assert.deepEqual(registry.brokerMetadata(), [{
    actionId: "example.read",
    requiredEntries: [{ slot: "token", key: "api.token", kinds: ["secret"] }]
  }]);
  assert.equal((await registry.execute("example.read", {
    input: {},
    values: { token: "swordfish" }
  })).tokenLength, 9);
  await assert.rejects(
    registry.execute("example.read", { input: { url: "https://evil.example" }, values: { token: "x" } }),
    (error) => error.code === "invalid_input"
  );
  await assert.rejects(
    registry.execute("example.read", { input: {}, values: { token: "x", extra: "y" } }),
    (error) => error.code === "unexpected_entry"
  );
  await assert.rejects(
    registry.execute("example.read", { input: {}, values: { token: "x".repeat(16_385) } }),
    (error) => error.code === "invalid_vault_value"
  );
});

test("fetchJson fixes browser security options and rejects destination drift", async () => {
  let captured;
  const fetchFn = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };
  const result = await fetchJson({
    fetchFn,
    url: "https://api.example/value",
    allowedOrigin: "https://api.example",
    headers: { accept: "application/json" }
  });

  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://api.example/value");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.referrerPolicy, "no-referrer");
  assert.equal(captured.init.headers.get("accept"), "application/json");

  await assert.rejects(
    fetchJson({
      fetchFn,
      url: "https://evil.example/value",
      allowedOrigin: "https://api.example"
    }),
    (error) => error.code === "destination_denied"
  );
  await assert.rejects(
    fetchJson({
      fetchFn,
      url: "https://api.example/value",
      allowedOrigin: "https://api.example",
      headers: { "x-task-header": "not allowed" }
    }),
    (error) => error.code === "unsafe_header"
  );
});
