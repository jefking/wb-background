export const PROTOCOL_VERSION = 1;

const MAX_TASK_ID_LENGTH = 96;
const MAX_SECRET_KEY_LENGTH = 128;

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

function defaultMessageChannelFactory() {
  if (typeof globalThis.MessageChannel !== "function") {
    throw new RuntimeError("unsupported", "MessageChannel is not available in this environment.");
  }
  return new globalThis.MessageChannel();
}

function isMessagePort(value) {
  return value
    && typeof value.postMessage === "function"
    && typeof value.close === "function";
}

function normalizeTaskId(value) {
  if (typeof value !== "string") {
    throw new TypeError("Task id must be a string.");
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_TASK_ID_LENGTH) {
    throw new RangeError(`Task id must contain 1–${MAX_TASK_ID_LENGTH} characters.`);
  }
  return id;
}

function normalizeFrequency(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Task frequencyMs must be a positive integer.");
  }
  return value;
}

function normalizeSecretKey(value) {
  if (typeof value !== "string") {
    throw new RuntimeError("invalid_key", "Secret key must be a string.");
  }
  const key = value.trim();
  if (key.length === 0 || key.length > MAX_SECRET_KEY_LENGTH) {
    throw new RuntimeError(
      "invalid_key",
      `Secret key must contain 1–${MAX_SECRET_KEY_LENGTH} characters.`
    );
  }
  return key;
}

/**
 * Runs registered task functions and supplies their brokered getSecret hook.
 * Scheduled tasks begin when the host connects and run once immediately.
 */
export class TaskRuntime {
  constructor({
    trustedHostOrigin,
    messageChannelFactory = defaultMessageChannelFactory,
    setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
    clearIntervalFn = (timer) => globalThis.clearInterval(timer),
    onTaskError = (error, taskId) => console.error(`Task “${taskId}” failed:`, error),
    onConnectionChange = () => {}
  } = {}) {
    if (typeof trustedHostOrigin !== "string" || trustedHostOrigin.length === 0) {
      throw new TypeError("trustedHostOrigin is required.");
    }

    this.trustedHostOrigin = trustedHostOrigin;
    this.messageChannelFactory = messageChannelFactory;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.onTaskError = onTaskError;
    this.onConnectionChange = onConnectionChange;
    this.tasks = new Map();
    this.pendingSecrets = new Map();
    this.brokerPort = null;
    this.windowTarget = null;
    this.requestSequence = 0;
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
  }

  /** Listen for the WB/v1 capability port sent by the trusted host page. */
  listen(windowTarget = globalThis.window) {
    if (!windowTarget || typeof windowTarget.addEventListener !== "function") {
      throw new RuntimeError("unsupported", "A browser window is required to listen for the host.");
    }
    if (this.windowTarget === windowTarget) return this;
    if (this.windowTarget) this.stopListening();
    this.windowTarget = windowTarget;
    windowTarget.addEventListener("message", this.handleWindowMessage);
    return this;
  }

  stopListening() {
    this.windowTarget?.removeEventListener("message", this.handleWindowMessage);
    this.windowTarget = null;
  }

  handleWindowMessage(event) {
    const message = event.data;
    if (event.source !== this.windowTarget?.parent
      || event.origin !== this.trustedHostOrigin
      || message?.type !== "wb.connect"
      || message?.protocol !== PROTOCOL_VERSION
      || message?.role !== "task") {
      return false;
    }

    const port = event.ports?.[0] ?? message.port;
    if (!isMessagePort(port)) return false;
    this.connect(port);
    return true;
  }

  /** Connect directly to a broker port. This is also useful in workers and tests. */
  connect(port) {
    if (!isMessagePort(port)) throw new TypeError("A MessagePort-compatible broker port is required.");

    if (this.brokerPort) {
      this.#rejectPendingSecrets("connection_replaced", "The broker connection was replaced.");
      this.#stopAllSchedules();
      this.#closePort(this.brokerPort);
    }

    this.brokerPort = port;
    port.onmessageerror = () => this.onConnectionChange({ connected: false, reason: "protocol_error" });
    port.start?.();
    port.postMessage({ type: "task.ready", protocol: PROTOCOL_VERSION });

    for (const task of this.tasks.values()) {
      this.#publishRegistration(task);
      this.#startSchedule(task);
    }
    this.onConnectionChange({ connected: true });
    return this;
  }

  /**
   * Register a task. Include frequencyMs to run it immediately on connection and
   * repeatedly thereafter; omit it for a task invoked only through runNow().
   */
  registerTask({ id, run, frequencyMs } = {}) {
    const normalizedId = normalizeTaskId(id);
    const normalizedFrequency = normalizeFrequency(frequencyMs);
    if (typeof run !== "function") throw new TypeError("Task run must be a function.");
    if (this.tasks.has(normalizedId)) {
      throw new RuntimeError("duplicate_task", `Task “${normalizedId}” is already registered.`);
    }

    const task = {
      id: normalizedId,
      run,
      frequencyMs: normalizedFrequency,
      timer: null,
      activeRun: null
    };
    this.tasks.set(normalizedId, task);

    if (this.brokerPort) {
      this.#publishRegistration(task);
      this.#startSchedule(task);
    }

    return Object.freeze({
      id: task.id,
      frequencyMs: task.frequencyMs,
      runNow: () => this.runTask(task.id),
      unregister: () => this.unregisterTask(task.id)
    });
  }

  unregisterTask(id) {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) return false;
    this.#stopSchedule(task);
    this.tasks.delete(normalizedId);
    this.#postToBroker({
      type: "task.unregister",
      protocol: PROTOCOL_VERSION,
      taskId: normalizedId
    });
    return true;
  }

  runTask(id) {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return Promise.reject(new RuntimeError("unknown_task", `Task “${normalizedId}” is not registered.`));
    }
    if (task.activeRun) return task.activeRun;

    const context = Object.freeze({
      getSecret: (key) => this.getSecret(key)
    });
    task.activeRun = Promise.resolve()
      .then(() => task.run(context))
      .finally(() => {
        task.activeRun = null;
      });
    return task.activeRun;
  }

  getSecret(requestedKey) {
    const key = normalizeSecretKey(requestedKey);
    if (!this.brokerPort) {
      return Promise.reject(new RuntimeError("broker_unavailable", "The broker is not connected."));
    }

    const channel = this.messageChannelFactory();
    if (!isMessagePort(channel?.port1) || !isMessagePort(channel?.port2)) {
      throw new RuntimeError("unsupported", "messageChannelFactory must return two MessagePorts.");
    }

    const requestId = `task-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        this.pendingSecrets.delete(requestId);
        this.#closePort(channel.port1);
        callback(value);
      };

      channel.port1.onmessage = (event) => {
        const result = event.data;
        if (result?.type !== "secret.result" || result?.protocol !== PROTOCOL_VERSION) {
          finish(reject, new RuntimeError("malformed_response", "Malformed secret response."));
          return;
        }
        if (!result.ok) {
          finish(reject, new RuntimeError(
            result.error?.code ?? "unknown_error",
            result.error?.message ?? "Secret request failed."
          ));
          return;
        }
        finish(resolve, result.value);
      };
      channel.port1.onmessageerror = () => {
        finish(reject, new RuntimeError("malformed_response", "Secret response could not be decoded."));
      };
      channel.port1.start?.();
      this.pendingSecrets.set(requestId, { port: channel.port1, reject });

      try {
        this.brokerPort.postMessage({
          type: "secret.request",
          protocol: PROTOCOL_VERSION,
          requestId,
          key,
          replyPort: channel.port2
        }, [channel.port2]);
      } catch {
        finish(reject, new RuntimeError("broker_unavailable", "The broker connection is unavailable."));
      }
    });
  }

  destroy() {
    this.stopListening();
    this.#stopAllSchedules();
    this.#rejectPendingSecrets("runtime_stopped", "The task runtime stopped.");
    this.#closePort(this.brokerPort);
    this.brokerPort = null;
    this.onConnectionChange({ connected: false, reason: "stopped" });
  }

  #publishRegistration(task) {
    this.#postToBroker({
      type: "task.register",
      protocol: PROTOCOL_VERSION,
      taskId: task.id,
      frequencyMs: task.frequencyMs
    });
  }

  #postToBroker(message) {
    if (!this.brokerPort) return false;
    try {
      this.brokerPort.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  #startSchedule(task) {
    if (task.frequencyMs === null || task.timer !== null) return;
    this.#runScheduledTask(task);
    task.timer = this.setIntervalFn(() => this.#runScheduledTask(task), task.frequencyMs);
  }

  #runScheduledTask(task) {
    this.runTask(task.id).catch((error) => this.onTaskError(error, task.id));
  }

  #stopSchedule(task) {
    if (task.timer === null) return;
    this.clearIntervalFn(task.timer);
    task.timer = null;
  }

  #stopAllSchedules() {
    for (const task of this.tasks.values()) this.#stopSchedule(task);
  }

  #rejectPendingSecrets(code, message) {
    for (const pending of this.pendingSecrets.values()) {
      this.#closePort(pending.port);
      pending.reject(new RuntimeError(code, message));
    }
    this.pendingSecrets.clear();
  }

  #closePort(port) {
    try {
      port?.close();
    } catch {
      // Closing an already-transferred port is harmless.
    }
  }
}

/** Create a browser runtime and immediately listen for its trusted host. */
export function createTaskRuntime(options) {
  const runtime = new TaskRuntime(options);
  runtime.listen(options?.windowTarget ?? globalThis.window);
  return runtime;
}
