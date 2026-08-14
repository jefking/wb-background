export const PROTOCOL_VERSION = 2;

const MAX_TASK_ID_LENGTH = 96;
const MAX_ACTION_ID_LENGTH = 96;
const MAX_TASK_ACTIONS = 16;
const MAX_ACTION_INPUT_BYTES = 8_192;

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

function normalizeActionId(value) {
  if (typeof value !== "string") throw new RuntimeError("invalid_action", "Action id must be a string.");
  const actionId = value.trim();
  if (actionId.length === 0 || actionId.length > MAX_ACTION_ID_LENGTH) {
    throw new RuntimeError("invalid_action", `Action id must contain 1–${MAX_ACTION_ID_LENGTH} characters.`);
  }
  return actionId;
}

function normalizeTaskActions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_TASK_ACTIONS) {
    throw new RangeError(`Task actions must be an array containing at most ${MAX_TASK_ACTIONS} action ids.`);
  }
  const actions = value.map(normalizeActionId);
  if (new Set(actions).size !== actions.length) {
    throw new RuntimeError("duplicate_action", "Task action declarations must be unique.");
  }
  return Object.freeze(actions);
}

function normalizeActionInput(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, (key, candidate) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError("Action input contains an unsafe property name.");
      }
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        throw new TypeError("Action input can only contain finite numbers.");
      }
      if (["bigint", "function", "symbol", "undefined"].includes(typeof candidate)) {
        throw new TypeError("Action input must contain only JSON values.");
      }
      return candidate;
    });
  } catch (error) {
    throw new RuntimeError("invalid_input", error.message);
  }
  if (serialized === undefined) {
    throw new RuntimeError("invalid_input", "Action input must be a JSON value.");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_ACTION_INPUT_BYTES) {
    throw new RuntimeError("input_too_large", "Action input exceeds 8,192 bytes.");
  }
  return JSON.parse(serialized);
}

/**
 * Runs registered task functions and supplies their brokered action hook.
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
    this.pendingActions = new Map();
    this.brokerPort = null;
    this.windowTarget = null;
    this.requestSequence = 0;
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
  }

  /** Listen for the WB/v2 capability port sent by the trusted host page. */
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
      this.#rejectPendingActions("connection_replaced", "The broker connection was replaced.");
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
  registerTask({ id, run, frequencyMs, actions } = {}) {
    const normalizedId = normalizeTaskId(id);
    const normalizedFrequency = normalizeFrequency(frequencyMs);
    const normalizedActions = normalizeTaskActions(actions);
    if (typeof run !== "function") throw new TypeError("Task run must be a function.");
    if (this.tasks.has(normalizedId)) {
      throw new RuntimeError("duplicate_task", `Task “${normalizedId}” is already registered.`);
    }

    const task = {
      id: normalizedId,
      run,
      frequencyMs: normalizedFrequency,
      actions: normalizedActions,
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
      invoke: (actionId, input = {}) => this.invokeAction(task.id, actionId, input)
    });
    task.activeRun = Promise.resolve()
      .then(() => task.run(context))
      .finally(() => {
        task.activeRun = null;
      });
    return task.activeRun;
  }

  invokeAction(requestedTaskId, requestedActionId, input = {}) {
    const taskId = normalizeTaskId(requestedTaskId);
    const actionId = normalizeActionId(requestedActionId);
    const task = this.tasks.get(taskId);
    if (!task) {
      return Promise.reject(new RuntimeError("unknown_task", `Task “${taskId}” is not registered.`));
    }
    if (!task.actions.includes(actionId)) {
      return Promise.reject(new RuntimeError(
        "undeclared_action",
        `Task “${taskId}” did not declare action “${actionId}”.`
      ));
    }
    const normalizedInput = normalizeActionInput(input);
    if (!this.brokerPort) {
      return Promise.reject(new RuntimeError("broker_unavailable", "The broker is not connected."));
    }

    const channel = this.messageChannelFactory();
    if (!isMessagePort(channel?.port1) || !isMessagePort(channel?.port2)) {
      throw new RuntimeError("unsupported", "messageChannelFactory must return two MessagePorts.");
    }

    const requestId = `action-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        this.pendingActions.delete(requestId);
        this.#closePort(channel.port1);
        callback(value);
      };

      channel.port1.onmessage = (event) => {
        const result = event.data;
        if (result?.type !== "action.result" || result?.protocol !== PROTOCOL_VERSION) {
          finish(reject, new RuntimeError("malformed_response", "Malformed action response."));
          return;
        }
        if (!result.ok) {
          finish(reject, new RuntimeError(
            result.error?.code ?? "unknown_error",
            result.error?.message ?? "Action request failed."
          ));
          return;
        }
        finish(resolve, result.data);
      };
      channel.port1.onmessageerror = () => {
        finish(reject, new RuntimeError("malformed_response", "Action response could not be decoded."));
      };
      channel.port1.start?.();
      this.pendingActions.set(requestId, { port: channel.port1, reject });

      try {
        this.brokerPort.postMessage({
          type: "action.request",
          protocol: PROTOCOL_VERSION,
          requestId,
          taskId,
          actionId,
          input: normalizedInput,
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
    this.#rejectPendingActions("runtime_stopped", "The task runtime stopped.");
    this.#closePort(this.brokerPort);
    this.brokerPort = null;
    this.onConnectionChange({ connected: false, reason: "stopped" });
  }

  #publishRegistration(task) {
    this.#postToBroker({
      type: "task.register",
      protocol: PROTOCOL_VERSION,
      taskId: task.id,
      frequencyMs: task.frequencyMs,
      actions: task.actions
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

  #rejectPendingActions(code, message) {
    for (const pending of this.pendingActions.values()) {
      this.#closePort(pending.port);
      pending.reject(new RuntimeError(code, message));
    }
    this.pendingActions.clear();
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
