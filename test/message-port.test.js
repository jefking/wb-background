import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

test("the host can resolve a vault value and return only a sanitized action result", async () => {
  const taskReply = new MessageChannel();
  const privacyControl = new MessageChannel();

  privacyControl.port2.once("message", ({ entries, replyPort }) => {
    assert.deepEqual(entries, [{
      slot: "city",
      key: "weather.city",
      revision: 7,
      kinds: ["variable", "secret"]
    }]);
    replyPort.postMessage({
      type: "vault.result",
      protocol: 2,
      ok: true,
      values: [{ slot: "city", value: "Vancouver" }]
    });
    replyPort.close();
  });

  const vaultReply = new MessageChannel();
  const vaultResultPromise = once(vaultReply.port1, "message");
  privacyControl.port1.postMessage({
    type: "vault.resolve",
    protocol: 2,
    entries: [{
      slot: "city",
      key: "weather.city",
      revision: 7,
      kinds: ["variable", "secret"]
    }],
    replyPort: vaultReply.port2
  }, [vaultReply.port2]);

  const [vaultResult] = await vaultResultPromise;
  assert.equal(vaultResult.values[0].value, "Vancouver");

  const resultPromise = once(taskReply.port1, "message");
  taskReply.port2.postMessage({
    type: "action.result",
    protocol: 2,
    ok: true,
    data: { temperatureC: 11, condition: "rain", humidity: 82 }
  });
  taskReply.port2.close();

  const [result] = await resultPromise;
  assert.deepEqual(result, {
    type: "action.result",
    protocol: 2,
    ok: true,
    data: { temperatureC: 11, condition: "rain", humidity: 82 }
  });
  assert.equal(JSON.stringify(result).includes("Vancouver"), false);

  taskReply.port1.close();
  vaultReply.port1.close();
  privacyControl.port1.close();
  privacyControl.port2.close();
});
