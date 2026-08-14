export const PROTOCOL_VERSION = 1;

export const VAULT_LIMITS = Object.freeze({
  keys: 128,
  keyLength: 128,
  valueLength: 16_384
});

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

function normalizeKey(value) {
  if (typeof value !== "string") {
    throw new VaultError("invalid_key", "Secret key must be a string.");
  }
  const key = value.trim();
  if (key.length === 0 || key.length > VAULT_LIMITS.keyLength) {
    throw new VaultError(
      "invalid_key",
      `Secret key must contain 1–${VAULT_LIMITS.keyLength} characters.`
    );
  }
  return key;
}

function normalizeValue(value) {
  if (typeof value !== "string") {
    throw new VaultError("invalid_value", "Secret value must be a string.");
  }
  if (value.length === 0 || value.length > VAULT_LIMITS.valueLength) {
    throw new VaultError(
      "invalid_value",
      `Secret value must contain 1–${VAULT_LIMITS.valueLength.toLocaleString("en-US")} characters.`
    );
  }
  return value;
}

function isMessagePort(value) {
  return value
    && typeof value.postMessage === "function"
    && typeof value.close === "function";
}

/** An in-memory vault whose contents disappear with the page that owns it. */
export class MemoryVault {
  constructor() {
    this.secrets = new Map();
    this.nextRevision = 1;
    this.listeners = new Set();
  }

  save(requestedKey, requestedValue) {
    const key = normalizeKey(requestedKey);
    const value = normalizeValue(requestedValue);
    if (!this.secrets.has(key) && this.secrets.size >= VAULT_LIMITS.keys) {
      throw new VaultError("vault_full", `The vault cannot contain more than ${VAULT_LIMITS.keys} keys.`);
    }
    if (!Number.isSafeInteger(this.nextRevision)) {
      throw new VaultError("revision_exhausted", "The vault revision counter is exhausted.");
    }

    const revision = this.nextRevision++;
    this.secrets.set(key, { value, revision });
    this.#notify({ type: "saved", key, revision });
    return Object.freeze({ key, revision });
  }

  get(requestedKey) {
    const key = normalizeKey(requestedKey);
    return this.secrets.get(key)?.value;
  }

  has(requestedKey) {
    const key = normalizeKey(requestedKey);
    return this.secrets.has(key);
  }

  delete(requestedKey) {
    const key = normalizeKey(requestedKey);
    if (!this.secrets.delete(key)) return false;
    this.#notify({ type: "deleted", key });
    return true;
  }

  clear() {
    if (this.secrets.size === 0) return false;
    this.secrets.clear();
    this.#notify({ type: "cleared" });
    return true;
  }

  catalog() {
    return [...this.secrets.entries()]
      .map(([key, entry]) => Object.freeze({ key, revision: entry.revision }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  resolve(requestedKey, revision) {
    let key;
    try {
      key = normalizeKey(requestedKey);
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code ?? "invalid_key", message: error.message }
      };
    }

    const entry = this.secrets.get(key);
    if (!entry) {
      return {
        ok: false,
        error: { code: "not_found", message: "The vault no longer has this key." }
      };
    }
    if (entry.revision !== revision) {
      return {
        ok: false,
        error: { code: "stale_revision", message: "The secret changed after access was granted." }
      };
    }
    return { ok: true, value: entry.value };
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Vault listener must be a function.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notify(change) {
    const catalog = this.catalog();
    for (const listener of this.listeners) listener(change, catalog);
  }
}

/** Bridges a MemoryVault to the host without exposing values to the host port. */
export class VaultProvider {
  constructor({
    vault,
    trustedHostOrigin,
    onConnectionChange = () => {}
  } = {}) {
    if (!(vault instanceof MemoryVault)) {
      throw new TypeError("vault must be a MemoryVault.");
    }
    if (typeof trustedHostOrigin !== "string" || trustedHostOrigin.length === 0) {
      throw new TypeError("trustedHostOrigin is required.");
    }

    this.vault = vault;
    this.trustedHostOrigin = trustedHostOrigin;
    this.onConnectionChange = onConnectionChange;
    this.brokerPort = null;
    this.windowTarget = null;
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
    this.handleBrokerMessage = this.handleBrokerMessage.bind(this);
    this.unsubscribe = vault.subscribe(() => this.sendCatalog());
  }

  listen(windowTarget = globalThis.window) {
    if (!windowTarget || typeof windowTarget.addEventListener !== "function") {
      throw new VaultError("unsupported", "A browser window is required to listen for the host.");
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
      || message?.role !== "privacy") {
      return false;
    }

    const port = event.ports?.[0] ?? message.port;
    if (!isMessagePort(port)) return false;
    this.connect(port);
    return true;
  }

  connect(port) {
    if (!isMessagePort(port)) throw new TypeError("A MessagePort-compatible broker port is required.");
    this.#closePort(this.brokerPort);
    this.brokerPort = port;
    port.onmessage = this.handleBrokerMessage;
    port.onmessageerror = () => this.onConnectionChange({ connected: false, reason: "protocol_error" });
    port.start?.();
    port.postMessage({ type: "privacy.ready", protocol: PROTOCOL_VERSION });
    this.sendCatalog();
    this.onConnectionChange({ connected: true });
    return this;
  }

  handleBrokerMessage(event) {
    const message = event.data;
    if (message?.type !== "secret.resolve" || message?.protocol !== PROTOCOL_VERSION) return false;

    const replyPort = event.ports?.[0] ?? message.replyPort;
    if (!isMessagePort(replyPort)) return false;
    this.#sendResult(replyPort, this.vault.resolve(message.key, message.revision));
    return true;
  }

  sendCatalog() {
    if (!this.brokerPort) return false;
    try {
      this.brokerPort.postMessage({
        type: "privacy.catalog",
        protocol: PROTOCOL_VERSION,
        entries: this.vault.catalog()
      });
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this.stopListening();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.#closePort(this.brokerPort);
    this.brokerPort = null;
    this.onConnectionChange({ connected: false, reason: "stopped" });
  }

  #sendResult(port, result) {
    try {
      port.postMessage({ type: "secret.result", protocol: PROTOCOL_VERSION, ...result });
    } finally {
      this.#closePort(port);
    }
  }

  #closePort(port) {
    try {
      port?.close();
    } catch {
      // Closing an already-transferred port is harmless.
    }
  }
}

export function createMemoryVault() {
  return new MemoryVault();
}

/** Create a provider and immediately listen for its trusted host. */
export function createVaultProvider(options) {
  const provider = new VaultProvider(options);
  provider.listen(options?.windowTarget ?? globalThis.window);
  return provider;
}
