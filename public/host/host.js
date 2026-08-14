import { ActionRegistry } from "/action-sdk/index.js";
import { createWeatherAction } from "/action-example/weather.js";
import { BrokerState, PROTOCOL_VERSION, validateFrameUrl } from "/broker-core.js";

const DEFAULT_TASK_URL = "http://127.0.0.1:8001/";
const DEFAULT_PRIVACY_URL = "http://127.0.0.1:8002/";
const HANDSHAKE_TIMEOUT_MS = 3_000;
const ACTION_TIMEOUT_MS = 8_000;
const MAX_ACTIVE_ACTIONS = 16;

const actionRegistry = new ActionRegistry();
actionRegistry.register(createWeatherAction());
const broker = new BrokerState({ actions: actionRegistry.brokerMetadata() });

const pendingRequests = new Map();
const activeRequests = new Map();

const elements = {
  pendingList: document.querySelector("#pending-list"),
  pendingCount: document.querySelector("#pending-count"),
  grantList: document.querySelector("#grant-list"),
  grantCount: document.querySelector("#grant-count"),
  catalogList: document.querySelector("#catalog-list"),
  catalogCount: document.querySelector("#catalog-count"),
  taskRegistration: document.querySelector("#task-registration"),
  notice: document.querySelector("#shell-notice")
};

const frames = {
  task: createFrameSession("task"),
  privacy: createFrameSession("privacy")
};

function createFrameSession(role) {
  return {
    role,
    frame: document.querySelector(`#${role}-frame`),
    form: document.querySelector(`#${role}-url-form`),
    input: document.querySelector(`#${role}-url`),
    error: document.querySelector(`#${role}-url-error`),
    status: document.querySelector(`#${role}-status`),
    url: null,
    origin: null,
    port: null,
    ready: false,
    handshakeTimer: null,
    connectionSequence: 0
  };
}

function setNotice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", isError);
}

function setFrameStatus(session, label, state = "waiting") {
  session.status.textContent = label;
  session.status.className = `status ${state}`;
}

function isMessagePort(value) {
  return value && typeof value.postMessage === "function" && typeof value.close === "function";
}

function closePort(port) {
  try {
    port?.close();
  } catch {
    // A transferred or already-closed port is harmless here.
  }
}

function sendActionResult(port, result) {
  if (!isMessagePort(port)) return;
  try {
    port.postMessage({
      type: "action.result",
      protocol: PROTOCOL_VERSION,
      ...result
    });
  } finally {
    closePort(port);
  }
}

function rejectRequest(record, code, message) {
  record.controller?.abort();
  sendActionResult(record.replyPort, { ok: false, error: { code, message } });
}

function rejectAllRequests(code, message) {
  for (const request of pendingRequests.values()) rejectRequest(request, code, message);
  pendingRequests.clear();
  for (const request of activeRequests.values()) rejectRequest(request, code, message);
  activeRequests.clear();
}

function rejectTaskRequests(taskId, code, message) {
  for (const [requestId, request] of pendingRequests) {
    if (request.taskId !== taskId) continue;
    pendingRequests.delete(requestId);
    rejectRequest(request, code, message);
  }
  for (const [requestId, request] of activeRequests) {
    if (request.taskId !== taskId) continue;
    activeRequests.delete(requestId);
    rejectRequest(request, code, message);
  }
}

function resetFrameState(role, reason) {
  const session = frames[role];
  session.connectionSequence += 1;
  session.ready = false;
  clearTimeout(session.handshakeTimer);
  closePort(session.port);
  session.port = null;

  rejectAllRequests(
    role === "task" ? "task_changed" : "provider_changed",
    role === "task" ? "The task frame changed." : "The privacy provider changed."
  );

  if (role === "task") broker.resetTask();
  else broker.resetPrivacy();

  setFrameStatus(session, reason, "waiting");
  renderBroker();
}

function connectFrame(role) {
  const session = frames[role];
  if (!session.url || !session.frame.contentWindow) return;

  resetFrameState(role, "Connecting");
  const sequence = session.connectionSequence;
  const channel = new MessageChannel();
  session.port = channel.port1;

  channel.port1.onmessage = (event) => {
    if (session.connectionSequence !== sequence || session.port !== channel.port1) return;
    if (role === "task") handleTaskMessage(session, event);
    else handlePrivacyMessage(session, event);
  };
  channel.port1.onmessageerror = () => {
    if (session.connectionSequence !== sequence) return;
    setFrameStatus(session, "Protocol error", "error");
  };
  channel.port1.start();

  session.handshakeTimer = setTimeout(() => {
    if (session.connectionSequence !== sequence || session.ready) return;
    setFrameStatus(session, "No v2 handshake", "error");
    closePort(session.port);
    session.port = null;
    setNotice(`${role === "task" ? "Task" : "Privacy"} frame did not complete the WB/v2 handshake.`, true);
  }, HANDSHAKE_TIMEOUT_MS);

  const connectMessage = {
    type: "wb.connect",
    protocol: PROTOCOL_VERSION,
    role,
    expectedOrigin: session.origin,
    port: channel.port2
  };

  try {
    // Privacy intentionally has an opaque sandbox origin. Its WindowProxy,
    // trusted-parent check, and transferred port form its connection boundary.
    const targetOrigin = role === "privacy" ? "*" : session.origin;
    session.frame.contentWindow.postMessage(connectMessage, targetOrigin, [channel.port2]);
  } catch (error) {
    clearTimeout(session.handshakeTimer);
    closePort(channel.port1);
    session.port = null;
    setFrameStatus(session, "Connection failed", "error");
    setNotice(`Could not connect the ${role} frame: ${error.message}`, true);
  }
}

function markReady(session, messageType) {
  const expectedType = `${session.role}.ready`;
  if (messageType !== expectedType) return false;
  session.ready = true;
  clearTimeout(session.handshakeTimer);
  setFrameStatus(session, "Connected · v2", "ready");
  setNotice("Task requests are declarative. Vault values terminate inside trusted Host actions.");
  renderBroker();
  return true;
}

function handleTaskMessage(session, event) {
  const message = event.data;
  if (!message || message.protocol !== PROTOCOL_VERSION || typeof message.type !== "string") return;

  if (message.type === "task.ready") {
    markReady(session, message.type);
    return;
  }
  if (!session.ready) return;

  if (message.type === "task.register") {
    const result = broker.registerTask(message);
    if (!result.ok) {
      setFrameStatus(session, "Invalid task", "error");
      setNotice("The task frame registered invalid or unknown action metadata.", true);
    }
    renderBroker();
    return;
  }

  if (message.type === "task.unregister") {
    rejectTaskRequests(message.taskId, "task_unregistered", "The task was unregistered.");
    broker.unregisterTask(message.taskId);
    renderBroker();
    return;
  }

  if (message.type !== "action.request") return;
  const replyPort = event.ports?.[0] ?? message.replyPort;
  if (!isMessagePort(replyPort)) return;

  let input;
  try {
    input = actionRegistry.prepareInput(message.actionId, message.input);
  } catch (error) {
    sendActionResult(replyPort, {
      ok: false,
      error: { code: error.code ?? "invalid_input", message: publicErrorMessage(error.code) }
    });
    return;
  }

  const decision = broker.request({
    requestId: message.requestId,
    taskId: message.taskId,
    actionId: message.actionId,
    input
  });
  if (decision.kind === "rejected") {
    sendActionResult(replyPort, {
      ok: false,
      error: { code: decision.error, message: publicErrorMessage(decision.error) }
    });
    return;
  }

  const record = Object.freeze({
    requestId: message.requestId,
    taskId: decision.taskId,
    actionId: decision.actionId,
    input,
    replyPort
  });
  if (decision.kind === "granted") {
    executeApprovedAction(record, decision.entries);
    return;
  }

  pendingRequests.set(record.requestId, record);
  const action = actionRegistry.describe(record.actionId);
  setNotice(`Task “${record.taskId}” requests action “${action.title}”.`);
  renderBroker();
}

function handlePrivacyMessage(session, event) {
  const message = event.data;
  if (!message || message.protocol !== PROTOCOL_VERSION || typeof message.type !== "string") return;

  if (message.type === "privacy.ready") {
    markReady(session, message.type);
    return;
  }
  if (!session.ready || message.type !== "privacy.catalog") return;

  const result = broker.setCatalog(message.entries);
  if (!result.ok) {
    setFrameStatus(session, "Invalid catalog", "error");
    setNotice("The privacy frame sent an invalid or oversized vault catalog.", true);
    return;
  }
  if (result.changed && activeRequests.size > 0) {
    for (const [requestId, request] of activeRequests) {
      activeRequests.delete(requestId);
      rejectRequest(request, "vault_changed", "The vault changed while the action was running.");
    }
  }
  if (result.revokedGrants.length > 0) {
    setNotice(`Vault changes revoked ${result.revokedGrants.length} action grant(s).`);
  }
  renderBroker();
}

function resolveVaultEntries(entries, signal) {
  const privacy = frames.privacy;
  if (!privacy.ready || !privacy.port) {
    return Promise.reject(Object.assign(new Error("The privacy frame is not connected."), {
      code: "provider_unavailable"
    }));
  }

  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", handleAbort);
      closePort(channel.port1);
      callback(value);
    };
    const handleAbort = () => finish(
      reject,
      Object.assign(new Error("The action was cancelled."), { code: "action_aborted" })
    );

    channel.port1.onmessage = (event) => {
      const result = event.data;
      if (result?.type !== "vault.result" || result?.protocol !== PROTOCOL_VERSION) {
        finish(reject, Object.assign(new Error("Malformed vault response."), { code: "malformed_response" }));
        return;
      }
      if (!result.ok) {
        finish(reject, Object.assign(
          new Error(result.error?.message ?? "Vault resolution failed."),
          { code: result.error?.code ?? "vault_error" }
        ));
        return;
      }
      if (!Array.isArray(result.values) || result.values.length !== entries.length) {
        finish(reject, Object.assign(new Error("Malformed vault values."), { code: "malformed_response" }));
        return;
      }

      const values = Object.create(null);
      for (const entry of result.values) {
        if (typeof entry?.slot !== "string"
          || typeof entry.value !== "string"
          || Object.hasOwn(values, entry.slot)
          || !entries.some((expected) => expected.slot === entry.slot)) {
          finish(reject, Object.assign(new Error("Malformed vault values."), { code: "malformed_response" }));
          return;
        }
        values[entry.slot] = entry.value;
      }
      finish(resolve, Object.freeze(values));
    };
    channel.port1.onmessageerror = () => finish(
      reject,
      Object.assign(new Error("Vault response could not be decoded."), { code: "malformed_response" })
    );
    channel.port1.start();
    signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      privacy.port.postMessage({
        type: "vault.resolve",
        protocol: PROTOCOL_VERSION,
        entries,
        replyPort: channel.port2
      }, [channel.port2]);
    } catch {
      finish(reject, Object.assign(new Error("The privacy frame is unavailable."), {
        code: "provider_unavailable"
      }));
    }
  });
}

async function executeApprovedAction(request, entries) {
  if (activeRequests.size >= MAX_ACTIVE_ACTIONS) {
    rejectRequest(request, "host_busy", "The Host has too many active actions.");
    return;
  }

  const controller = new AbortController();
  const active = { ...request, controller };
  activeRequests.set(request.requestId, active);
  const timeout = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);

  try {
    const values = await resolveVaultEntries(entries, controller.signal);
    const data = await actionRegistry.execute(request.actionId, {
      input: request.input,
      values,
      signal: controller.signal
    });
    if (activeRequests.get(request.requestId) !== active) return;
    sendActionResult(request.replyPort, { ok: true, data });
  } catch (error) {
    if (activeRequests.get(request.requestId) !== active) return;
    const code = error.code ?? "action_failed";
    sendActionResult(request.replyPort, {
      ok: false,
      error: { code, message: publicErrorMessage(code) }
    });
  } finally {
    clearTimeout(timeout);
    if (activeRequests.get(request.requestId) === active) activeRequests.delete(request.requestId);
  }
}

function approveRequest(requestId) {
  const result = broker.approve(requestId);
  if (!result.ok) {
    setNotice(publicErrorMessage(result.error), true);
    renderBroker();
    return;
  }

  for (const approvedId of result.requestIds) {
    const request = pendingRequests.get(approvedId);
    pendingRequests.delete(approvedId);
    if (request) executeApprovedAction(request, result.entries);
  }
  const action = actionRegistry.describe(result.actionId);
  setNotice(`Granted “${action.title}” to task “${result.taskId}”.`);
  renderBroker();
}

function denyRequest(requestId) {
  const result = broker.deny(requestId);
  if (!result.ok) return;

  const request = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  if (request) rejectRequest(request, "denied", "The Host denied this action request.");
  setNotice(`Denied action “${result.actionId}” for task “${result.taskId}”.`);
  renderBroker();
}

function revokeGrant(taskId, actionId) {
  if (!broker.revoke(taskId, actionId)) return;
  setNotice(`Revoked “${actionId}” from task “${taskId}”.`);
  renderBroker();
}

function renderBroker() {
  const snapshot = broker.snapshot();
  elements.pendingCount.textContent = String(snapshot.pending.length);
  elements.grantCount.textContent = String(snapshot.grants.length);
  elements.catalogCount.textContent = String(snapshot.catalog.length);
  elements.taskRegistration.textContent = snapshot.tasks.length === 0
    ? "No task has registered yet."
    : snapshot.tasks.map(({ taskId, frequencyMs, actions }) => {
      const frequency = frequencyMs === null ? "manual" : `every ${formatFrequency(frequencyMs)}`;
      return `${taskId} · ${frequency} · ${actions.join(", ") || "no actions"}`;
    }).join(" · ");

  elements.pendingList.replaceChildren();
  if (snapshot.pending.length === 0) {
    elements.pendingList.append(emptyMessage("No task is waiting for an action decision."));
  } else {
    for (const request of snapshot.pending) {
      const action = actionRegistry.describe(request.actionId);
      const item = document.createElement("div");
      item.className = "request";

      const heading = document.createElement("div");
      heading.className = "request-heading";
      const title = document.createElement("strong");
      title.textContent = action.title;
      heading.append(title);
      if (request.missingKeys.length > 0) {
        const missing = document.createElement("span");
        missing.className = "missing-key";
        missing.textContent = "entry unavailable";
        heading.append(missing);
      }

      const meta = document.createElement("p");
      meta.className = "request-meta";
      const entryNames = action.requiredEntries.map(({ key }) => key).join(", ");
      meta.textContent = `${request.taskId} · ${action.destination.method} ${action.destination.origin}${action.destination.path} · vault: ${entryNames}`;

      const actions = document.createElement("div");
      actions.className = "request-actions";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Approve action";
      approve.disabled = request.missingKeys.length > 0 || !frames.privacy.ready;
      approve.addEventListener("click", () => approveRequest(request.requestId));

      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "secondary";
      deny.textContent = "Deny";
      deny.addEventListener("click", () => denyRequest(request.requestId));
      actions.append(approve, deny);
      item.append(heading, meta, actions);
      elements.pendingList.append(item);
    }
  }

  elements.grantList.replaceChildren();
  if (snapshot.grants.length === 0) {
    elements.grantList.append(emptyMessage("No actions are granted."));
  } else {
    for (const grant of snapshot.grants) {
      const action = actionRegistry.describe(grant.actionId);
      const row = document.createElement("div");
      row.className = "grant-row";
      const label = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = action.title;
      const meta = document.createElement("span");
      meta.className = "grant-meta";
      meta.textContent = grant.taskId;
      label.append(title, meta);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => revokeGrant(grant.taskId, grant.actionId));
      row.append(label, revoke);
      elements.grantList.append(row);
    }
  }

  elements.catalogList.replaceChildren();
  if (snapshot.catalog.length === 0) {
    elements.catalogList.append(emptyMessage("Add weather.city in the Privacy frame."));
  } else {
    for (const entry of snapshot.catalog) {
      const pill = document.createElement("span");
      pill.className = `key-pill ${entry.kind}`;
      pill.textContent = `${entry.key} · ${entry.kind}`;
      pill.title = `Revision ${entry.revision}; value is not published to the Host catalog`;
      elements.catalogList.append(pill);
    }
  }
}

function formatFrequency(frequencyMs) {
  return frequencyMs % 1_000 === 0 ? `${frequencyMs / 1_000}s` : `${frequencyMs}ms`;
}

function emptyMessage(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = text;
  return paragraph;
}

function publicErrorMessage(code) {
  const messages = {
    invalid_request: "The task sent an invalid request identifier.",
    duplicate_request: "The task reused a pending request identifier.",
    too_many_pending_requests: "The task exceeded the pending-request limit.",
    unknown_task: "The action came from an unknown task.",
    action_not_declared: "The task did not declare this Host action.",
    unknown_action: "The Host does not implement this action.",
    invalid_input: "The action input failed validation.",
    input_too_large: "The action input exceeded its size limit.",
    input_too_complex: "The action input exceeded its complexity limit.",
    input_too_deep: "The action input was nested too deeply.",
    missing_entry: "Create the required vault entry before approving this action.",
    entry_kind_denied: "The required vault entry has an incompatible type.",
    unknown_request: "That action request is no longer pending.",
    stale_request: "That action request belongs to a previous frame generation.",
    denied: "The Host denied this action request.",
    provider_unavailable: "The Privacy provider is unavailable.",
    malformed_response: "A component returned a malformed response.",
    stale_revision: "A vault entry changed before the action could use it.",
    kind_mismatch: "A vault entry changed to an incompatible type.",
    action_aborted: "The action was cancelled or timed out.",
    network_error: "The approved service could not be reached.",
    service_error: "The approved service returned an error.",
    invalid_response: "The approved service returned an invalid response.",
    response_too_large: "The approved service response exceeded its size limit.",
    invalid_vault_value: "The vault value is invalid for this action.",
    destination_denied: "The action attempted to leave its approved destination.",
    host_busy: "The Host has too many active actions.",
    vault_changed: "The vault changed while the action was running.",
    action_failed: "The approved action failed."
  };
  return messages[code] ?? "The action could not be completed.";
}

function loadFrame(role, rawUrl) {
  const session = frames[role];
  const other = frames[role === "task" ? "privacy" : "task"];
  const validated = validateFrameUrl(rawUrl, {
    hostOrigin: window.location.origin,
    otherOrigin: other.origin
  });

  if (!validated.ok) {
    session.error.textContent = validated.error;
    return false;
  }

  session.error.textContent = "";
  resetFrameState(role, "Loading");
  session.url = validated.url;
  session.origin = validated.origin;
  session.input.value = validated.url;
  session.frame.src = validated.url;
  setNotice(`Loading ${role} frame from ${validated.origin}…`);
  return true;
}

for (const session of Object.values(frames)) {
  session.form.addEventListener("submit", (event) => {
    event.preventDefault();
    loadFrame(session.role, session.input.value);
  });
  session.frame.addEventListener("load", () => connectFrame(session.role));
}

frames.task.input.value = DEFAULT_TASK_URL;
frames.privacy.input.value = DEFAULT_PRIVACY_URL;
renderBroker();
loadFrame("task", DEFAULT_TASK_URL);
loadFrame("privacy", DEFAULT_PRIVACY_URL);
