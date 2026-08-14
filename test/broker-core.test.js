import assert from "node:assert/strict";
import test from "node:test";

import { BrokerState, LIMITS, validateFrameUrl } from "../public/host/broker-core.js";

const ACTIONS = [{
  actionId: "weather.current",
  requiredEntries: [{
    slot: "city",
    key: "weather.city",
    kinds: ["variable", "secret"]
  }]
}];

function stateWithEntry({ revision = 1, kind = "secret" } = {}) {
  const state = new BrokerState({ actions: ACTIONS });
  assert.deepEqual(state.registerTask({
    taskId: "weather-task",
    frequencyMs: 5_000,
    actions: ["weather.current"]
  }), {
    ok: true,
    taskId: "weather-task",
    frequencyMs: 5_000,
    actions: ["weather.current"]
  });
  assert.deepEqual(state.setCatalog([{ key: "weather.city", revision, kind }]), {
    ok: true,
    changed: true,
    revokedGrants: []
  });
  return state;
}

function request(state, requestId, input = {}) {
  return state.request({
    requestId,
    taskId: "weather-task",
    actionId: "weather.current",
    input
  });
}

test("an action request becomes a task-scoped revision-bound grant", () => {
  const state = stateWithEntry();
  assert.deepEqual(request(state, "request-1"), {
    kind: "pending",
    taskId: "weather-task",
    actionId: "weather.current",
    missingKeys: []
  });

  assert.deepEqual(state.approve("request-1"), {
    ok: true,
    taskId: "weather-task",
    actionId: "weather.current",
    entries: [{
      slot: "city",
      key: "weather.city",
      kinds: ["variable", "secret"],
      revision: 1,
      kind: "secret"
    }],
    requestIds: ["request-1"]
  });

  assert.deepEqual(request(state, "request-2"), {
    kind: "granted",
    taskId: "weather-task",
    actionId: "weather.current",
    input: {},
    entries: [{
      slot: "city",
      key: "weather.city",
      kinds: ["variable", "secret"],
      revision: 1,
      kind: "secret"
    }]
  });
  assert.equal(state.snapshot().grants.length, 1);
});

test("unknown and undeclared actions are rejected", () => {
  const state = stateWithEntry();
  assert.deepEqual(state.request({
    requestId: "request-1",
    taskId: "weather-task",
    actionId: "unknown.action",
    input: {}
  }), { kind: "rejected", error: "action_not_declared" });
  assert.deepEqual(state.request({
    requestId: "request-2",
    taskId: "unknown-task",
    actionId: "weather.current",
    input: {}
  }), { kind: "rejected", error: "unknown_task" });
});

test("denial removes only the selected request and creates no grant", () => {
  const state = stateWithEntry();
  request(state, "request-1");

  assert.deepEqual(state.deny("request-1"), {
    ok: true,
    requestId: "request-1",
    taskId: "weather-task",
    actionId: "weather.current"
  });
  assert.equal(state.snapshot().pending.length, 0);
  assert.equal(request(state, "request-2").kind, "pending");
  assert.deepEqual(state.snapshot().pending.map(({ requestId }) => requestId), ["request-2"]);
  assert.equal(state.snapshot().grants.length, 0);
});

test("a task cannot fan out concurrent requests for one action", () => {
  const state = stateWithEntry();
  assert.equal(request(state, "request-1").kind, "pending");
  assert.deepEqual(request(state, "request-2"), {
    kind: "rejected",
    error: "action_in_flight"
  });

  assert.deepEqual(state.approve("request-1").requestIds, ["request-1"]);
  assert.equal(state.snapshot().pending.length, 0);
});

test("entry revision, kind, deletion, and frame resets invalidate grants", () => {
  const state = stateWithEntry();
  request(state, "request-1");
  state.approve("request-1");

  assert.deepEqual(state.setCatalog([{
    key: "weather.city",
    revision: 2,
    kind: "variable"
  }]), {
    ok: true,
    changed: true,
    revokedGrants: [{ taskId: "weather-task", actionId: "weather.current" }]
  });
  assert.equal(state.snapshot().grants.length, 0);

  request(state, "request-2");
  state.approve("request-2");
  assert.deepEqual(state.setCatalog([]).revokedGrants, [{
    taskId: "weather-task",
    actionId: "weather.current"
  }]);

  state.setCatalog([{ key: "weather.city", revision: 3, kind: "secret" }]);
  request(state, "request-3");
  assert.deepEqual(state.resetTask().pendingRequestIds, ["request-3"]);
  assert.equal(state.snapshot().catalog.length, 1);
  assert.equal(state.snapshot().taskGeneration, 1);

  assert.deepEqual(state.resetPrivacy().pendingRequestIds, []);
  assert.equal(state.snapshot().catalog.length, 0);
  assert.equal(state.snapshot().privacyGeneration, 1);
});

test("missing entries block approval and incompatible kinds are rejected", () => {
  const state = new BrokerState({
    actions: [{
      actionId: "secret.only",
      requiredEntries: [{ slot: "token", key: "api.token", kinds: ["secret"] }]
    }]
  });
  state.registerTask({ taskId: "task", actions: ["secret.only"] });
  state.setCatalog([{ key: "api.token", revision: 1, kind: "variable" }]);
  assert.deepEqual(state.request({
    requestId: "request-1",
    taskId: "task",
    actionId: "secret.only",
    input: {}
  }).missingKeys, ["api.token"]);
  assert.deepEqual(state.approve("request-1"), { ok: false, error: "entry_kind_denied" });
});

test("pending requests and catalogs are bounded", () => {
  const state = new BrokerState({
    actions: [...ACTIONS, {
      actionId: "weather.forecast",
      requiredEntries: ACTIONS[0].requiredEntries
    }]
  });
  for (let index = 0; index < LIMITS.pendingRequests; index += 1) {
    const taskId = `weather-task-${index}`;
    state.registerTask({ taskId, actions: ["weather.current", "weather.forecast"] });
    assert.equal(state.request({
      requestId: `request-${index}`,
      taskId,
      actionId: "weather.current",
      input: {}
    }).kind, "pending");
  }
  assert.deepEqual(state.request({
    requestId: "overflow",
    taskId: "weather-task-0",
    actionId: "weather.forecast",
    input: {}
  }), {
    kind: "rejected",
    error: "too_many_pending_requests"
  });

  const oversizedCatalog = Array.from({ length: LIMITS.catalogEntries + 1 }, (_, index) => ({
    key: `key-${index}`,
    revision: 1,
    kind: "secret"
  }));
  assert.deepEqual(state.setCatalog(oversizedCatalog), {
    ok: false,
    error: "invalid_catalog",
    changed: false,
    revokedGrants: []
  });
});

test("task registrations retain schedules and declared Host actions", () => {
  const state = new BrokerState({ actions: ACTIONS });
  assert.deepEqual(state.registerTask({
    taskId: "heartbeat",
    frequencyMs: 5_000,
    actions: ["weather.current"]
  }), {
    ok: true,
    taskId: "heartbeat",
    frequencyMs: 5_000,
    actions: ["weather.current"]
  });
  assert.deepEqual(state.registerTask({ taskId: "manual", actions: [] }), {
    ok: true,
    taskId: "manual",
    frequencyMs: null,
    actions: []
  });
  assert.deepEqual(state.snapshot().tasks, [
    { taskId: "heartbeat", frequencyMs: 5_000, actions: ["weather.current"] },
    { taskId: "manual", frequencyMs: null, actions: [] }
  ]);
  assert.deepEqual(state.registerTask({ taskId: "bad", actions: ["unknown.action"] }), {
    ok: false,
    error: "invalid_task_actions"
  });
  assert.deepEqual(state.registerTask({
    taskId: "heartbeat",
    actions: []
  }), {
    ok: false,
    error: "duplicate_task_registration"
  });
  assert.equal(state.unregisterTask("manual"), true);
});

test("frame URL validation requires mutually distinct HTTP(S) origins", () => {
  assert.deepEqual(
    validateFrameUrl("not a url", { hostOrigin: "http://127.0.0.1:8000" }).error,
    "Enter an absolute HTTP(S) URL."
  );
  assert.equal(
    validateFrameUrl("file:///tmp/task.html", { hostOrigin: "http://127.0.0.1:8000" }).ok,
    false
  );
  assert.equal(
    validateFrameUrl("http://127.0.0.1:8000/task", { hostOrigin: "http://127.0.0.1:8000" }).ok,
    false
  );
  assert.equal(
    validateFrameUrl("http://127.0.0.1:8002/task", {
      hostOrigin: "http://127.0.0.1:8000",
      otherOrigin: "http://127.0.0.1:8002"
    }).ok,
    false
  );
  assert.deepEqual(
    validateFrameUrl("http://127.0.0.1:8001", {
      hostOrigin: "http://127.0.0.1:8000",
      otherOrigin: "http://127.0.0.1:8002"
    }),
    { ok: true, url: "http://127.0.0.1:8001/", origin: "http://127.0.0.1:8001" }
  );
});
