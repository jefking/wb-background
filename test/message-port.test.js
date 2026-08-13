import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

test("a one-shot reply port can pass through the host without exposing its payload", async () => {
  const taskReply = new MessageChannel();
  const privacyControl = new MessageChannel();

  privacyControl.port2.once("message", ({ key, revision, replyPort }) => {
    assert.equal(key, "demo.secret");
    assert.equal(revision, 7);
    replyPort.postMessage({ type: "secret.result", protocol: 1, ok: true, value: "swordfish" });
    replyPort.close();
  });

  const resultPromise = once(taskReply.port1, "message");
  privacyControl.port1.postMessage({
    type: "secret.resolve",
    protocol: 1,
    key: "demo.secret",
    revision: 7,
    replyPort: taskReply.port2
  }, [taskReply.port2]);

  const [result] = await resultPromise;
  assert.deepEqual(result, {
    type: "secret.result",
    protocol: 1,
    ok: true,
    value: "swordfish"
  });

  taskReply.port1.close();
  privacyControl.port1.close();
  privacyControl.port2.close();
});
