import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { MemoryVault, VaultError, VaultProvider } from "./index.js";

test("MemoryVault saves, reads, revisions, and deletes secrets in memory", () => {
  const vault = new MemoryVault();
  const changes = [];
  vault.subscribe((change, catalog) => changes.push({ change, catalog }));

  assert.deepEqual(vault.save(" beta ", "first"), { key: "beta", revision: 1 });
  assert.deepEqual(vault.save("alpha", "second"), { key: "alpha", revision: 2 });
  assert.equal(vault.get("beta"), "first");
  assert.deepEqual(vault.catalog(), [
    { key: "alpha", revision: 2 },
    { key: "beta", revision: 1 }
  ]);

  assert.deepEqual(vault.save("beta", "updated"), { key: "beta", revision: 3 });
  assert.deepEqual(vault.resolve("beta", 1), {
    ok: false,
    error: { code: "stale_revision", message: "The secret changed after access was granted." }
  });
  assert.deepEqual(vault.resolve("beta", 3), { ok: true, value: "updated" });
  assert.equal(vault.delete("beta"), true);
  assert.equal(vault.get("beta"), undefined);
  assert.equal(changes.length, 4);
});

test("MemoryVault rejects invalid keys and values", () => {
  const vault = new MemoryVault();
  assert.throws(() => vault.save("", "value"), (error) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "invalid_key");
    return true;
  });
  assert.throws(() => vault.save("key", ""), (error) => {
    assert.equal(error.code, "invalid_value");
    return true;
  });
});

test("VaultProvider publishes catalogs and resolves over transferred ports", async () => {
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
    { type: "privacy.ready", protocol: 1 },
    { type: "privacy.catalog", protocol: 1, entries: [] }
  ]);

  const saved = vault.save("demo.secret", "swordfish");
  await waitForImmediate();
  assert.deepEqual(controlMessages.at(-1), {
    type: "privacy.catalog",
    protocol: 1,
    entries: [saved]
  });

  const reply = new MessageChannel();
  const resultPromise = once(reply.port1, "message");
  control.port2.postMessage({
    type: "secret.resolve",
    protocol: 1,
    key: saved.key,
    revision: saved.revision,
    replyPort: reply.port2
  }, [reply.port2]);

  const [result] = await resultPromise;
  assert.deepEqual(result, {
    type: "secret.result",
    protocol: 1,
    ok: true,
    value: "swordfish"
  });

  reply.port1.close();
  provider.destroy();
  control.port2.close();
});
