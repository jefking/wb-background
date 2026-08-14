import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { MemoryVault, VaultError, VaultProvider } from "./index.js";

test("MemoryVault stores visible variables and hidden-secret metadata with revisions", () => {
  const vault = new MemoryVault();
  const changes = [];
  vault.subscribe((change, catalog) => changes.push({ change, catalog }));

  assert.deepEqual(vault.save(" weather.city ", "Vancouver", { kind: "variable" }), {
    key: "weather.city",
    revision: 1,
    kind: "variable"
  });
  assert.deepEqual(vault.save("api.token", "swordfish"), {
    key: "api.token",
    revision: 2,
    kind: "secret"
  });
  assert.equal(vault.get("weather.city"), "Vancouver");
  assert.deepEqual(vault.catalog(), [
    { key: "api.token", revision: 2, kind: "secret" },
    { key: "weather.city", revision: 1, kind: "variable" }
  ]);

  assert.deepEqual(vault.save("weather.city", "Victoria", { kind: "secret" }), {
    key: "weather.city",
    revision: 3,
    kind: "secret"
  });
  assert.deepEqual(vault.resolve("weather.city", 1), {
    ok: false,
    error: { code: "stale_revision", message: "The vault entry changed after access was granted." }
  });
  assert.deepEqual(vault.resolve("weather.city", 3, ["variable"]), {
    ok: false,
    error: { code: "kind_mismatch", message: "The vault entry kind is not allowed for this action." }
  });
  assert.deepEqual(vault.resolve("weather.city", 3, ["secret"]), {
    ok: true,
    value: "Victoria",
    kind: "secret"
  });
  assert.equal(vault.delete("weather.city"), true);
  assert.equal(changes.length, 4);
});

test("MemoryVault rejects invalid keys, values, and entry kinds", () => {
  const vault = new MemoryVault();
  assert.throws(() => vault.save("", "value"), (error) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "invalid_key");
    return true;
  });
  assert.throws(() => vault.save("key", ""), (error) => error.code === "invalid_value");
  assert.throws(
    () => vault.save("key", "value", { kind: "public" }),
    (error) => error.code === "invalid_kind"
  );
});

test("VaultProvider publishes kind metadata and resolves an approved entry set", async () => {
  const vault = new MemoryVault();
  const provider = new VaultProvider({
    vault,
    trustedHostOrigin: "https://host.example"
  });
  const control = new MessageChannel();
  const controlMessages = [];
  control.port2.on("message", (message) => controlMessages.push(message));

  provider.connect(control.port1);
  await waitForImmediate();
  assert.deepEqual(controlMessages, [
    { type: "privacy.ready", protocol: 2 },
    { type: "privacy.catalog", protocol: 2, entries: [] }
  ]);

  const saved = vault.save("weather.city", "Vancouver", { kind: "secret" });
  await waitForImmediate();
  assert.deepEqual(controlMessages.at(-1), {
    type: "privacy.catalog",
    protocol: 2,
    entries: [saved]
  });

  const reply = new MessageChannel();
  const resultPromise = once(reply.port1, "message");
  control.port2.postMessage({
    type: "vault.resolve",
    protocol: 2,
    entries: [{
      slot: "city",
      key: saved.key,
      revision: saved.revision,
      kinds: ["variable", "secret"]
    }],
    replyPort: reply.port2
  }, [reply.port2]);

  const [result] = await resultPromise;
  assert.deepEqual(result, {
    type: "vault.result",
    protocol: 2,
    ok: true,
    values: [{ slot: "city", value: "Vancouver" }]
  });

  reply.port1.close();
  provider.destroy();
  control.port2.close();
});
