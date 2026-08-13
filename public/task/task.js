(function taskFrame() {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const TRUSTED_HOST_ORIGIN = "http://127.0.0.1:8000";
  const RUN_INTERVAL_MS = 5_000;
  const MAX_LOG_ENTRIES = 40;

  const status = document.querySelector("#connection-status");
  const runState = document.querySelector("#run-state");
  const keyInput = document.querySelector("#secret-key");
  const activityLog = document.querySelector("#activity-log");

  let brokerPort = null;
  let requestInFlight = false;
  let sequence = 0;

  function connect(port) {
    try {
      brokerPort?.close();
    } catch {
      // Reconnection replaces the prior capability.
    }

    brokerPort = port;
    brokerPort.onmessageerror = () => {
      status.textContent = "Protocol error";
      status.className = "status";
    };
    brokerPort.start();
    brokerPort.postMessage({ type: "task.ready", protocol: PROTOCOL_VERSION });
    status.textContent = "Broker connected";
    status.className = "status ready";
    runState.textContent = "Ready";
    runTask();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent
      || event.origin !== TRUSTED_HOST_ORIGIN
      || message?.type !== "wb.connect"
      || message?.protocol !== PROTOCOL_VERSION
      || message?.role !== "task") {
      return;
    }

    const port = event.ports?.[0] ?? message.port;
    if (!port || typeof port.postMessage !== "function") return;
    connect(port);
  });

  function requestSecret(key) {
    if (!brokerPort) return Promise.reject(new Error("Broker is not connected."));

    const channel = new MessageChannel();
    const requestId = `task-${Date.now().toString(36)}-${(++sequence).toString(36)}`;

    return new Promise((resolve, reject) => {
      channel.port1.onmessage = (event) => {
        const result = event.data;
        channel.port1.close();
        if (result?.type !== "secret.result" || result?.protocol !== PROTOCOL_VERSION) {
          reject(new Error("Malformed secret response."));
          return;
        }
        if (!result.ok) {
          const error = new Error(result.error?.message ?? "Secret request failed.");
          error.code = result.error?.code ?? "unknown_error";
          reject(error);
          return;
        }
        resolve(result.value);
      };
      channel.port1.onmessageerror = () => {
        channel.port1.close();
        reject(new Error("Secret response could not be decoded."));
      };
      channel.port1.start();

      try {
        brokerPort.postMessage({
          type: "secret.request",
          protocol: PROTOCOL_VERSION,
          requestId,
          key,
          replyPort: channel.port2
        }, [channel.port2]);
      } catch {
        channel.port1.close();
        reject(new Error("The broker connection is no longer available."));
      }
    });
  }

  async function runTask() {
    if (!brokerPort || requestInFlight) return;
    const key = keyInput.value.trim();
    if (!key) {
      appendLog("error", "invalid", "Enter a key to request.");
      return;
    }

    requestInFlight = true;
    runState.textContent = "Waiting for secret decision…";
    let secret;
    try {
      secret = await requestSecret(key);
      appendLog("success", "success", `${maskSecret(secret)} received for ${key}`);
      runState.textContent = "Last run completed";
    } catch (error) {
      appendLog("error", error.code ?? "error", error.message);
      runState.textContent = "Last run failed";
    } finally {
      secret = null;
      requestInFlight = false;
    }
  }

  function maskSecret(value) {
    const length = typeof value === "string" ? value.length : 0;
    const marks = "•".repeat(Math.min(length, 12));
    return `${marks}${length > 12 ? "…" : ""} (${length} chars)`;
  }

  function appendLog(className, outcome, detail) {
    const item = document.createElement("li");
    item.className = className;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date().toLocaleTimeString();
    const result = document.createElement("span");
    result.className = "outcome";
    result.textContent = outcome;
    const message = document.createElement("span");
    message.className = "detail";
    message.textContent = detail;
    item.append(time, result, message);
    activityLog.prepend(item);

    while (activityLog.children.length > MAX_LOG_ENTRIES) {
      activityLog.lastElementChild.remove();
    }
  }

  setInterval(runTask, RUN_INTERVAL_MS);
}());
