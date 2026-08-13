(function privacyFrame() {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const TRUSTED_HOST_ORIGIN = "http://127.0.0.1:8000";
  const MAX_KEYS = 128;
  const MAX_KEY_LENGTH = 128;
  const MAX_VALUE_LENGTH = 16_384;

  const secrets = new Map();
  let nextRevision = 1;
  let brokerPort = null;

  const status = document.querySelector("#connection-status");
  const keyInput = document.querySelector("#secret-key");
  const valueInput = document.querySelector("#secret-value");
  const saveButton = document.querySelector("#save-secret");
  const editorMessage = document.querySelector("#editor-message");
  const keyList = document.querySelector("#key-list");
  const keyCount = document.querySelector("#key-count");

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent
      || event.origin !== TRUSTED_HOST_ORIGIN
      || message?.type !== "wb.connect"
      || message?.protocol !== PROTOCOL_VERSION
      || message?.role !== "privacy") {
      return;
    }

    const port = event.ports?.[0] ?? message.port;
    if (!port || typeof port.postMessage !== "function") return;
    connect(port);
  });

  function connect(port) {
    try {
      brokerPort?.close();
    } catch {
      // Reconnection replaces the prior capability.
    }

    brokerPort = port;
    brokerPort.onmessage = handleBrokerMessage;
    brokerPort.onmessageerror = () => {
      status.textContent = "Protocol error";
      status.className = "status";
    };
    brokerPort.start();
    brokerPort.postMessage({ type: "privacy.ready", protocol: PROTOCOL_VERSION });
    sendCatalog();
    status.textContent = "Broker connected";
    status.className = "status ready";
  }

  function handleBrokerMessage(event) {
    const message = event.data;
    if (message?.type !== "secret.resolve" || message?.protocol !== PROTOCOL_VERSION) return;

    const replyPort = event.ports?.[0] ?? message.replyPort;
    if (!replyPort || typeof replyPort.postMessage !== "function") return;

    const entry = secrets.get(message.key);
    if (!entry) {
      sendResult(replyPort, {
        ok: false,
        error: { code: "not_found", message: "The privacy frame no longer has this key." }
      });
      return;
    }
    if (entry.revision !== message.revision) {
      sendResult(replyPort, {
        ok: false,
        error: { code: "stale_revision", message: "The secret changed after access was granted." }
      });
      return;
    }

    sendResult(replyPort, { ok: true, value: entry.value });
  }

  function sendResult(port, result) {
    try {
      port.postMessage({ type: "secret.result", protocol: PROTOCOL_VERSION, ...result });
    } finally {
      port.close();
    }
  }

  function sendCatalog() {
    if (!brokerPort) return;
    const entries = [...secrets.entries()]
      .map(([key, entry]) => ({ key, revision: entry.revision }))
      .sort((left, right) => left.key.localeCompare(right.key));
    brokerPort.postMessage({
      type: "privacy.catalog",
      protocol: PROTOCOL_VERSION,
      entries
    });
  }

  function saveSecret() {
    const key = keyInput.value.trim();
    const value = valueInput.value;

    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      showEditorMessage("Keys must contain 1–128 characters.", true);
      return;
    }
    if (value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      showEditorMessage("Values must contain 1–16,384 characters.", true);
      return;
    }
    if (!secrets.has(key) && secrets.size >= MAX_KEYS) {
      showEditorMessage("This provider has reached its 128-key limit.", true);
      return;
    }

    secrets.set(key, { value, revision: nextRevision++ });
    valueInput.value = "";
    showEditorMessage(`Saved “${key}” in this frame’s memory.`);
    renderKeys();
    sendCatalog();
  }

  function deleteSecret(key) {
    if (!secrets.delete(key)) return;
    showEditorMessage(`Deleted “${key}”. Any grant was invalidated.`);
    renderKeys();
    sendCatalog();
  }

  function showEditorMessage(message, isError = false) {
    editorMessage.textContent = message;
    editorMessage.classList.toggle("error", isError);
  }

  function renderKeys() {
    keyCount.textContent = String(secrets.size);
    keyList.replaceChildren();

    if (secrets.size === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No secrets are stored.";
      keyList.append(empty);
      return;
    }

    for (const [key, entry] of [...secrets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const row = document.createElement("div");
      row.className = "key-row";
      const label = document.createElement("div");
      const keyName = document.createElement("code");
      keyName.textContent = key;
      const revision = document.createElement("span");
      revision.className = "key-meta";
      revision.textContent = `revision ${entry.revision}`;
      label.append(keyName, revision);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteSecret(key));
      row.append(label, remove);
      keyList.append(row);
    }
  }

  saveButton.addEventListener("click", saveSecret);
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveSecret();
  });
  renderKeys();
}());
