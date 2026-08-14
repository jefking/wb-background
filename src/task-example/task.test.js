import assert from "node:assert/strict";
import test from "node:test";

import { registerExampleTask } from "./task.js";

test("the example registers a five-second task that requests demo.secret", async () => {
  let definition;
  const output = [];
  const runtime = {
    registerTask(candidate) {
      definition = candidate;
      return { id: candidate.id };
    }
  };

  const registration = registerExampleTask(runtime, (message) => output.push(message));
  assert.deepEqual(registration, { id: "heartbeat" });
  assert.equal(definition.id, "heartbeat");
  assert.equal(definition.frequencyMs, 5_000);

  const requestedKeys = [];
  await definition.run({
    async getSecret(key) {
      requestedKeys.push(key);
      return "mock-value";
    }
  });
  assert.deepEqual(requestedKeys, ["demo.secret"]);
  assert.deepEqual(output, ["heartbeat called with a 10-character secret"]);
});
