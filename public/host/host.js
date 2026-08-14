import { BrokerState, PROTOCOL_VERSION, validateFrameUrl } from "/broker-core.js";

const DEFAULT_TASK_URL = "http://127.0.0.1:8001/";
const DEFAULT_PRIVACY_URL = "http://127.0.0.1:8002/";
const HANDSHAKE_TIMEOUT_MS = 3_000;

const broker = new BrokerState();
const pendingPorts = new Map();

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

function sendResult(port, result) {
  if (!isMessagePort(port)) return;
  try {
    port.postMessage({
      type: "secret.result",
      protocol: PROTOCOL_VERSION,
      ...result
    });
  } finally {
    closePort(port);
  }
}

function rejectAllPending(code, message) {
  for (const port of pendingPorts.values()) {
    sendResult(port, { ok: false, error: { code, message } });
  }
  pendingPorts.clear();
}

function resetFrameState(role, reason) {
  const session = frames[role];
  session.connectionSequence += 1;
  session.ready = false;
  clearTimeout(session.handshakeTimer);
  closePort(session.port);
  session.port = null;

  rejectAllPending(
    role === "task" ? "task_changed" : "provider_changed",
    role === "task" ? "The task frame changed." : "The privacy frame changed."
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
    setFrameStatus(session, "No v1 handshake", "error");
    closePort(session.port);
    session.port = null;
    setNotice(`${role === "task" ? "Task" : "Privacy"} frame did not complete the WB/v1 handshake.`, true);
  }, HANDSHAKE_TIMEOUT_MS);

  const connectMessage = {
    type: "wb.connect",
    protocol: PROTOCOL_VERSION,
    role,
    expectedOrigin: session.origin,
    port: channel.port2
  };

  try {
    // The privacy frame intentionally has an opaque sandbox origin. Its WindowProxy,
    // trusted parent check, and this one-use transferred port are its identity boundary.
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
  setFrameStatus(session, "Connected · v1", "ready");
  setNotice("Frames are isolated. Secret decisions are made in this host page.");
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
      setNotice("The task frame sent invalid schedule metadata.", true);
    }
    renderBroker();
    return;
  }

  if (message.type === "task.unregister") {
    broker.unregisterTask(message.taskId);
    renderBroker();
    return;
  }

  if (message.type !== "secret.request") return;

  const replyPort = event.ports?.[0] ?? message.replyPort;
  if (!isMessagePort(replyPort)) return;

  const decision = broker.request({ requestId: message.requestId, key: message.key });
  if (decision.kind === "rejected") {
    sendResult(replyPort, {
      ok: false,
      error: { code: decision.error, message: humanError(decision.error) }
    });
    return;
  }

  if (decision.kind === "granted") {
    forwardToPrivacy({
      requestId: message.requestId,
      key: decision.key,
      revision: decision.revision,
      replyPort
    });
    return;
  }

  pendingPorts.set(message.requestId, replyPort);
  setNotice(`Task requests access to “${decision.key}”.`);
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
    setNotice("The privacy frame sent an invalid or oversized key catalog.", true);
    return;
  }

  if (result.revokedKeys.length > 0) {
    setNotice(`Secret changes revoked: ${result.revokedKeys.join(", ")}.`);
  }
  renderBroker();
}

function forwardToPrivacy({ requestId, key, revision, replyPort }) {
  const privacy = frames.privacy;
  if (!privacy.ready || !privacy.port) {
    sendResult(replyPort, {
      ok: false,
      error: { code: "provider_unavailable", message: "The privacy frame is not connected." }
    });
    return;
  }

  try {
    privacy.port.postMessage({
      type: "secret.resolve",
      protocol: PROTOCOL_VERSION,
      requestId,
      key,
      revision,
      replyPort
    }, [replyPort]);
  } catch {
    sendResult(replyPort, {
      ok: false,
      error: { code: "provider_unavailable", message: "The privacy frame could not receive the request." }
    });
  }
}

function approveRequest(requestId) {
  const result = broker.approve(requestId);
  if (!result.ok) {
    setNotice(humanError(result.error), true);
    renderBroker();
    return;
  }

  for (const approvedId of result.requestIds) {
    const replyPort = pendingPorts.get(approvedId);
    pendingPorts.delete(approvedId);
    if (replyPort) {
      forwardToPrivacy({
        requestId: approvedId,
        key: result.key,
        revision: result.revision,
        replyPort
      });
    }
  }
  setNotice(`Granted “${result.key}” to the current task document.`);
  renderBroker();
}

function denyRequest(requestId) {
  const result = broker.deny(requestId);
  if (!result.ok) return;

  const replyPort = pendingPorts.get(requestId);
  pendingPorts.delete(requestId);
  sendResult(replyPort, {
    ok: false,
    error: { code: "denied", message: "The browser shell denied this request." }
  });
  setNotice(`Denied this request for “${result.key}”.`);
  renderBroker();
}

function revokeGrant(key) {
  if (!broker.revoke(key)) return;
  setNotice(`Revoked future access to “${key}”.`);
  renderBroker();
}

function renderBroker() {
  const snapshot = broker.snapshot();
  elements.pendingCount.textContent = String(snapshot.pending.length);
  elements.grantCount.textContent = String(snapshot.grants.length);
  elements.catalogCount.textContent = String(snapshot.catalog.length);
  elements.taskRegistration.textContent = snapshot.tasks.length === 0
    ? "No task has registered yet."
    : snapshot.tasks.map(({ taskId, frequencyMs }) => frequencyMs === null
      ? `${taskId} · manual`
      : `${taskId} · every ${formatFrequency(frequencyMs)}`).join(" · ");

  elements.pendingList.replaceChildren();
  if (snapshot.pending.length === 0) {
    elements.pendingList.append(emptyMessage("No task is waiting for a decision."));
  } else {
    for (const request of snapshot.pending) {
      const item = document.createElement("div");
      item.className = "request";

      const heading = document.createElement("div");
      heading.className = "request-heading";
      const key = document.createElement("code");
      key.textContent = request.key;
      heading.append(key);

      const hasKey = snapshot.catalog.some((entry) => entry.key === request.key);
      if (!hasKey) {
        const missing = document.createElement("span");
        missing.className = "missing-key";
        missing.textContent = "key not present";
        heading.append(missing);
      }

      const meta = document.createElement("p");
      meta.className = "request-meta";
      meta.textContent = frames.task.url ?? "Unknown task URL";

      const actions = document.createElement("div");
      actions.className = "request-actions";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Approve & grant";
      approve.disabled = !hasKey || !frames.privacy.ready;
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
    elements.grantList.append(emptyMessage("No keys are granted."));
  } else {
    for (const grant of snapshot.grants) {
      const row = document.createElement("div");
      row.className = "grant-row";
      const key = document.createElement("code");
      key.textContent = grant.key;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => revokeGrant(grant.key));
      row.append(key, revoke);
      elements.grantList.append(row);
    }
  }

  elements.catalogList.replaceChildren();
  if (snapshot.catalog.length === 0) {
    elements.catalogList.append(emptyMessage("Add a key in the privacy frame."));
  } else {
    for (const entry of snapshot.catalog) {
      const pill = document.createElement("span");
      pill.className = "key-pill";
      pill.textContent = entry.key;
      pill.title = `Revision ${entry.revision}`;
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

function humanError(code) {
  const messages = {
    invalid_request: "The task sent an invalid request identifier.",
    invalid_key: "Secret keys must contain 1–128 characters.",
    duplicate_request: "The task reused a pending request identifier.",
    too_many_pending_requests: "The task exceeded the pending-request limit.",
    missing_key: "Create this key in the privacy frame before approving it.",
    unknown_request: "That request is no longer pending.",
    stale_request: "That request belongs to a previous frame generation."
  };
  return messages[code] ?? "The request could not be completed.";
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
