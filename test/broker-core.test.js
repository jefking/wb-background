import assert from "node:assert/strict";
import test from "node:test";

import {
  BrokerState,
  LIMITS,
  validateFrameUrl
} from "../public/host/broker-core.js";

function stateWithSecret(key = "demo.secret", revision = 1) {
  const state = new BrokerState();
  assert.deepEqual(state.setCatalog([{ key, revision }]), { ok: true, revokedKeys: [] });
  return state;
}

test("a request becomes an active revision-bound grant", () => {
  const state = stateWithSecret();
  assert.deepEqual(
    state.request({ requestId: "request-1", key: "demo.secret" }),
    { kind: "pending", key: "demo.secret" }
  );

  assert.deepEqual(state.approve("request-1"), {
    ok: true,
    key: "demo.secret",
    revision: 1,
    requestIds: ["request-1"]
  });

  assert.deepEqual(
    state.request({ requestId: "request-2", key: "demo.secret" }),
    { kind: "granted", key: "demo.secret", revision: 1 }
  );
  assert.equal(state.snapshot().grants.length, 1);
});

test("denial removes only the selected request and creates no grant", () => {
  const state = stateWithSecret();
  state.request({ requestId: "request-1", key: "demo.secret" });
  state.request({ requestId: "request-2", key: "other.secret" });

  assert.deepEqual(state.deny("request-1"), {
    ok: true,
    requestId: "request-1",
    key: "demo.secret"
  });
  assert.deepEqual(state.snapshot().pending.map(({ requestId }) => requestId), ["request-2"]);
  assert.equal(state.snapshot().grants.length, 0);
});

test("approving a key flushes all matching pending requests", () => {
  const state = stateWithSecret();
  state.request({ requestId: "request-1", key: "demo.secret" });
  state.request({ requestId: "request-2", key: "demo.secret" });

  assert.deepEqual(state.approve("request-1").requestIds, ["request-1", "request-2"]);
  assert.equal(state.snapshot().pending.length, 0);
});

test("a changed or deleted catalog revision invalidates its grant", () => {
  const state = stateWithSecret();
  state.request({ requestId: "request-1", key: "demo.secret" });
  state.approve("request-1");

  assert.deepEqual(state.setCatalog([{ key: "demo.secret", revision: 2 }]), {
    ok: true,
    revokedKeys: ["demo.secret"]
  });
  assert.equal(state.snapshot().grants.length, 0);

  state.request({ requestId: "request-2", key: "demo.secret" });
  state.approve("request-2");
  assert.deepEqual(state.setCatalog([]), { ok: true, revokedKeys: ["demo.secret"] });
});

test("task and privacy resets clear pending requests and grants", () => {
  const state = stateWithSecret();
  state.request({ requestId: "request-1", key: "demo.secret" });
  state.approve("request-1");
  state.request({ requestId: "request-2", key: "other.secret" });

  assert.deepEqual(state.resetTask(), {
    pendingRequestIds: ["request-2"],
    revokedKeys: ["demo.secret"]
  });
  assert.equal(state.snapshot().catalog.length, 1);
  assert.equal(state.snapshot().taskGeneration, 1);

  state.request({ requestId: "request-3", key: "demo.secret" });
  assert.deepEqual(state.resetPrivacy().pendingRequestIds, ["request-3"]);
  assert.equal(state.snapshot().catalog.length, 0);
  assert.equal(state.snapshot().privacyGeneration, 1);
});

test("pending requests and catalogs are bounded", () => {
  const state = new BrokerState();
  for (let index = 0; index < LIMITS.pendingRequests; index += 1) {
    assert.equal(
      state.request({ requestId: `request-${index}`, key: `secret-${index}` }).kind,
      "pending"
    );
  }
  assert.deepEqual(
    state.request({ requestId: "overflow", key: "overflow.secret" }),
    { kind: "rejected", error: "too_many_pending_requests" }
  );

  const oversizedCatalog = Array.from({ length: LIMITS.catalogEntries + 1 }, (_, index) => ({
    key: `key-${index}`,
    revision: 1
  }));
  assert.deepEqual(state.setCatalog(oversizedCatalog), {
    ok: false,
    error: "invalid_catalog",
    revokedKeys: []
  });
});

test("task registrations retain explicit schedule frequencies", () => {
  const state = new BrokerState();
  assert.deepEqual(state.registerTask({ taskId: "heartbeat", frequencyMs: 5_000 }), {
    ok: true,
    taskId: "heartbeat",
    frequencyMs: 5_000
  });
  assert.deepEqual(state.registerTask({ taskId: "manual" }), {
    ok: true,
    taskId: "manual",
    frequencyMs: null
  });
  assert.deepEqual(state.snapshot().tasks, [
    { taskId: "heartbeat", frequencyMs: 5_000 },
    { taskId: "manual", frequencyMs: null }
  ]);
  assert.equal(state.unregisterTask("manual"), true);
  assert.equal(state.snapshot().tasks.length, 1);
  state.resetTask();
  assert.deepEqual(state.snapshot().tasks, []);
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
