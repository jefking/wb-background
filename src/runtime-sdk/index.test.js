import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { RuntimeError, TaskRuntime } from "./index.js";

function fakePort(messages) {
  return {
    close() {},
    postMessage(message) {
      messages.push(message);
    },
    start() {}
  };
}

test("scheduled tasks register their frequency and run without overlapping", async () => {
  const messages = [];
  const intervals = [];
  const cleared = [];
  let releaseFirstRun;
  let runCount = 0;
  const firstRun = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });
  const runtime = new TaskRuntime({
    trustedHostOrigin: "https://host.example",
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      cleared.push(timer);
    },
    onTaskError() {}
  });

  const controller = runtime.registerTask({
    id: " heartbeat ",
    frequencyMs: 5_000,
    async run() {
      runCount += 1;
      if (runCount === 1) await firstRun;
    }
  });
  runtime.connect(fakePort(messages));
  await waitForImmediate();

  assert.deepEqual(messages.slice(0, 2), [
    { type: "task.ready", protocol: 1 },
    { type: "task.register", protocol: 1, taskId: "heartbeat", frequencyMs: 5_000 }
  ]);
  assert.equal(intervals[0].delay, 5_000);
  assert.equal(runCount, 1);

  intervals[0].callback();
  await waitForImmediate();
  assert.equal(runCount, 1, "a timer tick reuses the active run instead of overlapping it");

  releaseFirstRun();
  await waitForImmediate();
  intervals[0].callback();
  await waitForImmediate();
  assert.equal(runCount, 2);

  assert.equal(controller.unregister(), true);
  assert.deepEqual(cleared, [intervals[0]]);
  assert.deepEqual(messages.at(-1), {
    type: "task.unregister",
    protocol: 1,
    taskId: "heartbeat"
  });
  runtime.destroy();
});

test("getSecret uses a one-shot reply port for values and broker errors", async () => {
  const control = new MessageChannel();
  const runtime = new TaskRuntime({
    trustedHostOrigin: "https://host.example",
    messageChannelFactory: () => new MessageChannel()
  });

  control.port2.on("message", (message) => {
    if (message.type !== "secret.request") return;
    const result = message.key === "demo.secret"
      ? { ok: true, value: "swordfish" }
      : { ok: false, error: { code: "denied", message: "No access." } };
    message.replyPort.postMessage({
      type: "secret.result",
      protocol: 1,
      ...result
    });
    message.replyPort.close();
  });
  runtime.connect(control.port1);

  assert.equal(await runtime.getSecret(" demo.secret "), "swordfish");

  await assert.rejects(runtime.getSecret("denied.secret"), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "denied");
    assert.equal(error.message, "No access.");
    return true;
  });

  runtime.destroy();
  control.port2.close();
});

test("manual tasks expose runNow and validate schedule metadata", async () => {
  const runtime = new TaskRuntime({ trustedHostOrigin: "https://host.example" });
  let received;
  const task = runtime.registerTask({
    id: "manual",
    async run(context) {
      received = context;
    }
  });

  assert.equal(task.frequencyMs, null);
  await task.runNow();
  assert.equal(typeof received.getSecret, "function");
  assert.throws(
    () => runtime.registerTask({ id: "bad", frequencyMs: 0, run() {} }),
    /positive integer/
  );
  runtime.destroy();
});
