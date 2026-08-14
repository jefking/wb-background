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

test("scheduled tasks publish declared actions and run without overlapping", async () => {
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
    id: " weather ",
    frequencyMs: 5_000,
    actions: ["weather.current"],
    async run() {
      runCount += 1;
      if (runCount === 1) await firstRun;
    }
  });
  runtime.connect(fakePort(messages));
  await waitForImmediate();

  assert.deepEqual(messages.slice(0, 2), [
    { type: "task.ready", protocol: 2 },
    {
      type: "task.register",
      protocol: 2,
      taskId: "weather",
      frequencyMs: 5_000,
      actions: ["weather.current"]
    }
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
    protocol: 2,
    taskId: "weather"
  });
  runtime.destroy();
});

test("invoke sends bounded declarative input and resolves an action result", async () => {
  const control = new MessageChannel();
  const runtime = new TaskRuntime({
    trustedHostOrigin: "https://host.example",
    messageChannelFactory: () => new MessageChannel()
  });
  runtime.registerTask({
    id: "weather",
    actions: ["weather.current"],
    run() {}
  });

  control.port2.on("message", (message) => {
    if (message.type !== "action.request") return;
    assert.equal(message.protocol, 2);
    assert.equal(message.taskId, "weather");
    assert.equal(message.actionId, "weather.current");
    assert.deepEqual(message.input, { units: "metric" });
    message.replyPort.postMessage({
      type: "action.result",
      protocol: 2,
      ok: true,
      data: { temperatureC: 12.5, condition: "rain" }
    });
    message.replyPort.close();
  });
  runtime.connect(control.port1);

  assert.deepEqual(
    await runtime.invokeAction("weather", "weather.current", { units: "metric" }),
    { temperatureC: 12.5, condition: "rain" }
  );
  await assert.rejects(
    runtime.invokeAction("weather", "undeclared.action", {}),
    (error) => error instanceof RuntimeError && error.code === "undeclared_action"
  );
  assert.throws(
    () => runtime.invokeAction("weather", "weather.current", { value: undefined }),
    (error) => error instanceof RuntimeError && error.code === "invalid_input"
  );

  runtime.destroy();
  control.port2.close();
});

test("manual tasks expose runNow and validate action declarations", async () => {
  const runtime = new TaskRuntime({ trustedHostOrigin: "https://host.example" });
  let received;
  const task = runtime.registerTask({
    id: "manual",
    actions: [],
    async run(context) {
      received = context;
    }
  });

  assert.equal(task.frequencyMs, null);
  await task.runNow();
  assert.equal(typeof received.invoke, "function");
  assert.throws(
    () => runtime.registerTask({ id: "bad", frequencyMs: 0, run() {} }),
    /positive integer/
  );
  assert.throws(
    () => runtime.registerTask({ id: "duplicate", actions: ["a", "a"], run() {} }),
    /unique/
  );
  runtime.destroy();
});
