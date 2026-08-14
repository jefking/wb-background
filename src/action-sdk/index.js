export const ACTION_LIMITS = Object.freeze({
  actions: 32,
  actionIdLength: 96,
  titleLength: 96,
  descriptionLength: 240,
  entryBindings: 8,
  slotLength: 64,
  keyLength: 128,
  inputBytes: 8_192,
  outputBytes: 65_536,
  jsonDepth: 8,
  jsonNodes: 512,
  jsonStringLength: 4_096,
  vaultValueLength: 16_384,
  responseBytes: 65_536,
  requestBodyBytes: 16_384
});

const ENTRY_KINDS = new Set(["variable", "secret"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "authorization", "content-type"]);

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

function normalizeString(value, label, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new RangeError(`${label} must contain 1–${maxLength} characters.`);
  }
  return normalized;
}

export function normalizeActionId(value) {
  return normalizeString(value, "Action id", ACTION_LIMITS.actionIdLength);
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Copy an untrusted structured-clone value into a bounded, frozen JSON value.
 * Objects use null prototypes and prototype-pollution keys are rejected.
 */
export function cloneBoundedJson(value, { maxBytes = ACTION_LIMITS.inputBytes } = {}) {
  let nodes = 0;

  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > ACTION_LIMITS.jsonNodes) {
      throw new ActionError("input_too_complex", "Action data contains too many values.");
    }
    if (depth > ACTION_LIMITS.jsonDepth) {
      throw new ActionError("input_too_deep", "Action data is nested too deeply.");
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new ActionError("invalid_input", "Action data can only contain finite numbers.");
      }
      return candidate;
    }
    if (typeof candidate === "string") {
      if (candidate.length > ACTION_LIMITS.jsonStringLength) {
        throw new ActionError("input_too_large", "An action string is too long.");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => visit(item, depth + 1)));
    }
    if (!candidate || typeof candidate !== "object") {
      throw new ActionError("invalid_input", "Action data must contain only JSON values.");
    }

    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ActionError("invalid_input", "Action data must use plain objects.");
    }

    const output = Object.create(null);
    const entries = Object.entries(candidate);
    if (entries.length > 64) {
      throw new ActionError("input_too_complex", "An action object has too many properties.");
    }
    for (const [key, entryValue] of entries) {
      if (key.length === 0 || key.length > ACTION_LIMITS.slotLength || UNSAFE_KEYS.has(key)) {
        throw new ActionError("invalid_input", "Action data contains an invalid property name.");
      }
      output[key] = visit(entryValue, depth + 1);
    }
    return Object.freeze(output);
  };

  const clone = visit(value, 0);
  const serialized = JSON.stringify(clone);
  if (serialized === undefined || utf8Length(serialized) > maxBytes) {
    throw new ActionError("input_too_large", `Action data exceeds ${maxBytes.toLocaleString("en-US")} bytes.`);
  }
  return clone;
}

function normalizeRequiredEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > ACTION_LIMITS.entryBindings) {
    throw new RangeError(`An action must require 1–${ACTION_LIMITS.entryBindings} vault entries.`);
  }
  const slots = new Set();
  const normalized = entries.map((entry) => {
    const slot = normalizeString(entry?.slot, "Entry slot", ACTION_LIMITS.slotLength);
    const key = normalizeString(entry?.key, "Vault key", ACTION_LIMITS.keyLength);
    if (slots.has(slot)) throw new ActionError("duplicate_slot", `Entry slot “${slot}” is duplicated.`);
    slots.add(slot);

    const kinds = entry?.kinds ?? ["variable", "secret"];
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => !ENTRY_KINDS.has(kind))) {
      throw new TypeError(`Entry slot “${slot}” has invalid accepted kinds.`);
    }
    return Object.freeze({ slot, key, kinds: Object.freeze([...new Set(kinds)]) });
  });
  return Object.freeze(normalized);
}

function normalizeDestination(destination) {
  if (!destination || typeof destination !== "object") {
    throw new TypeError("Action destination metadata is required.");
  }
  let origin;
  try {
    origin = new URL(destination.origin).origin;
  } catch {
    throw new TypeError("Action destination origin must be an absolute URL origin.");
  }
  if (origin !== destination.origin || (!origin.startsWith("https://") && !origin.startsWith("http://"))) {
    throw new TypeError("Action destination must be an exact HTTP(S) origin without a path.");
  }
  const method = normalizeString(destination.method, "Action method", 12).toUpperCase();
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
    throw new TypeError("Action destination method is not supported.");
  }
  const path = normalizeString(destination.path, "Action path", 160);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Action destination path must be an origin-relative path.");
  }
  return Object.freeze({ origin, method, path });
}

/** Host-owned registry for declarative actions. Task documents cannot add definitions. */
export class ActionRegistry {
  constructor() {
    this.actions = new Map();
  }

  register(definition = {}) {
    if (this.actions.size >= ACTION_LIMITS.actions) {
      throw new ActionError("too_many_actions", "The host action registry is full.");
    }
    const id = normalizeActionId(definition.id);
    if (this.actions.has(id)) throw new ActionError("duplicate_action", `Action “${id}” is already registered.`);
    if (typeof definition.execute !== "function") throw new TypeError("Action execute must be a function.");
    if (definition.validateInput !== undefined && typeof definition.validateInput !== "function") {
      throw new TypeError("Action validateInput must be a function when provided.");
    }

    const action = Object.freeze({
      id,
      title: normalizeString(definition.title, "Action title", ACTION_LIMITS.titleLength),
      description: normalizeString(
        definition.description,
        "Action description",
        ACTION_LIMITS.descriptionLength
      ),
      destination: normalizeDestination(definition.destination),
      requiredEntries: normalizeRequiredEntries(definition.requiredEntries),
      validateInput: definition.validateInput ?? ((input) => input),
      execute: definition.execute
    });
    this.actions.set(id, action);
    return this.describe(id);
  }

  has(id) {
    try {
      return this.actions.has(normalizeActionId(id));
    } catch {
      return false;
    }
  }

  describe(id) {
    const action = this.actions.get(normalizeActionId(id));
    if (!action) return null;
    return Object.freeze({
      id: action.id,
      title: action.title,
      description: action.description,
      destination: action.destination,
      requiredEntries: action.requiredEntries
    });
  }

  descriptions() {
    return [...this.actions.keys()].sort().map((id) => this.describe(id));
  }

  brokerMetadata() {
    return this.descriptions().map(({ id: actionId, requiredEntries }) => ({
      actionId,
      requiredEntries
    }));
  }

  prepareInput(id, untrustedInput = Object.create(null)) {
    const action = this.actions.get(normalizeActionId(id));
    if (!action) throw new ActionError("unknown_action", "The requested action is not registered by the host.");
    const bounded = cloneBoundedJson(untrustedInput);
    const validated = action.validateInput(bounded);
    return cloneBoundedJson(validated === undefined ? bounded : validated);
  }

  async execute(id, { input, values, signal } = {}) {
    const action = this.actions.get(normalizeActionId(id));
    if (!action) throw new ActionError("unknown_action", "The requested action is not registered by the host.");
    const preparedInput = this.prepareInput(id, input);
    const preparedValues = Object.create(null);
    const suppliedSlots = new Set(Object.keys(values ?? {}));

    for (const binding of action.requiredEntries) {
      if (!suppliedSlots.delete(binding.slot) || typeof values[binding.slot] !== "string") {
        throw new ActionError("missing_entry", `The host did not resolve required entry “${binding.key}”.`);
      }
      if (values[binding.slot].length === 0
        || values[binding.slot].length > ACTION_LIMITS.vaultValueLength) {
        throw new ActionError("invalid_vault_value", `Vault entry “${binding.key}” has an invalid size.`);
      }
      preparedValues[binding.slot] = values[binding.slot];
    }
    if (suppliedSlots.size > 0) {
      throw new ActionError("unexpected_entry", "The host supplied an entry the action did not request.");
    }

    const result = await action.execute({
      input: preparedInput,
      values: Object.freeze(preparedValues),
      signal
    });
    return cloneBoundedJson(result, { maxBytes: ACTION_LIMITS.outputBytes });
  }
}

function normalizeHeaders(headers = {}) {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(normalizedName)) {
      throw new ActionError("unsafe_header", `Header “${name}” is not allowed for a brokered action.`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new ActionError("unsafe_header", `Header “${name}” has an invalid value.`);
    }
    output.set(normalizedName, value);
  }
  return output;
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ActionError("response_too_large", "The action response exceeds its size limit.");
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (utf8Length(text) > maxBytes) {
      throw new ActionError("response_too_large", "The action response exceeds its size limit.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ActionError("response_too_large", "The action response exceeds its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Execute a tightly constrained JSON request from trusted action code. */
export async function fetchJson({
  fetchFn = globalThis.fetch,
  url,
  allowedOrigin,
  method = "GET",
  headers,
  body,
  signal,
  maxResponseBytes = ACTION_LIMITS.responseBytes
} = {}) {
  if (typeof fetchFn !== "function") throw new ActionError("fetch_unavailable", "Fetch is unavailable.");
  let target;
  let expectedOrigin;
  try {
    target = new URL(url);
    expectedOrigin = new URL(allowedOrigin).origin;
  } catch {
    throw new ActionError("invalid_destination", "The action destination is invalid.");
  }
  if (target.origin !== expectedOrigin || target.username || target.password) {
    throw new ActionError("destination_denied", "The action destination is outside its allowed origin.");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new ActionError("destination_denied", "Only HTTP(S) action destinations are allowed.");
  }

  const normalizedMethod = normalizeString(method, "Request method", 12).toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "POST") {
    throw new ActionError("method_denied", "This action client only permits GET and POST.");
  }
  if (normalizedMethod === "GET" && body !== undefined) {
    throw new ActionError("invalid_request", "GET actions cannot include a request body.");
  }
  if (body !== undefined && (typeof body !== "string" || utf8Length(body) > ACTION_LIMITS.requestBodyBytes)) {
    throw new ActionError("request_too_large", "The action request body is invalid or too large.");
  }

  const normalizedHeaders = normalizeHeaders(headers);
  let response;
  try {
    response = await fetchFn(target.href, {
      method: normalizedMethod,
      headers: normalizedHeaders,
      body,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw new ActionError("action_aborted", "The action was cancelled or timed out.");
    throw new ActionError("network_error", `The action service could not be reached: ${error.message}`);
  }

  if (response.url && new URL(response.url).origin !== expectedOrigin) {
    throw new ActionError("destination_denied", "The action response came from an unexpected origin.");
  }
  if (!response.ok) {
    throw new ActionError("service_error", `The action service returned HTTP ${response.status}.`);
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/(?:^|\s|;)application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new ActionError("invalid_response", "The action service did not return JSON.");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBoundedBody(response, maxResponseBytes));
  } catch (error) {
    if (error instanceof ActionError) throw error;
    throw new ActionError("invalid_response", "The action service returned malformed JSON.");
  }
  return cloneBoundedJson(parsed, { maxBytes: maxResponseBytes });
}
