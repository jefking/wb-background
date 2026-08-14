export const PROTOCOL_VERSION = 2;

export const LIMITS = Object.freeze({
  keyLength: 128,
  requestIdLength: 96,
  taskIdLength: 96,
  actionIdLength: 96,
  taskActions: 16,
  actionBindings: 8,
  registeredTasks: 32,
  pendingRequests: 32,
  catalogEntries: 128,
  inputBytes: 8_192
});

const ENTRY_KINDS = new Set(["variable", "secret"]);

export function validateKey(value) {
  if (typeof value !== "string") return { ok: false, error: "invalid_key" };
  const key = value.trim();
  if (key.length === 0 || key.length > LIMITS.keyLength) {
    return { ok: false, error: "invalid_key" };
  }
  return { ok: true, key };
}

export function validateFrameUrl(value, { hostOrigin, otherOrigin } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Enter an absolute HTTP(S) URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only HTTP(S) frame URLs are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Frame URLs cannot contain credentials." };
  }
  if (hostOrigin && url.origin === hostOrigin) {
    return { ok: false, error: "A frame must use a different origin from the host." };
  }
  if (otherOrigin && url.origin === otherOrigin) {
    return { ok: false, error: "Task and privacy frames must use different origins." };
  }

  return { ok: true, url: url.href, origin: url.origin };
}

function normalizeIdentifier(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function validRequestId(requestId) {
  return normalizeIdentifier(requestId, LIMITS.requestIdLength) === requestId;
}

function validRevision(revision) {
  return Number.isSafeInteger(revision) && revision > 0;
}

function validFrequency(frequencyMs) {
  return frequencyMs === null || (Number.isSafeInteger(frequencyMs) && frequencyMs > 0);
}

function validInput(input) {
  try {
    const serialized = JSON.stringify(input);
    return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= LIMITS.inputBytes;
  } catch {
    return false;
  }
}

function normalizeActionMetadata(actions) {
  if (!Array.isArray(actions)) throw new TypeError("Host actions must be an array.");
  const normalized = new Map();
  for (const action of actions) {
    const actionId = normalizeIdentifier(action?.actionId, LIMITS.actionIdLength);
    if (!actionId || normalized.has(actionId)
      || !Array.isArray(action.requiredEntries)
      || action.requiredEntries.length === 0
      || action.requiredEntries.length > LIMITS.actionBindings) {
      throw new TypeError("Host action metadata is invalid.");
    }
    const slots = new Set();
    const requiredEntries = action.requiredEntries.map((entry) => {
      const slot = normalizeIdentifier(entry?.slot, 64);
      const validatedKey = validateKey(entry?.key);
      const kinds = entry?.kinds;
      if (!slot || slots.has(slot) || !validatedKey.ok
        || !Array.isArray(kinds) || kinds.length === 0
        || kinds.some((kind) => !ENTRY_KINDS.has(kind))) {
        throw new TypeError("Host action entry metadata is invalid.");
      }
      slots.add(slot);
      return Object.freeze({ slot, key: validatedKey.key, kinds: Object.freeze([...new Set(kinds)]) });
    });
    normalized.set(actionId, Object.freeze({ actionId, requiredEntries: Object.freeze(requiredEntries) }));
  }
  return normalized;
}

function grantKey(taskId, actionId) {
  return `${taskId}\u0000${actionId}`;
}

/** State-only action permission broker. Vault values never enter this class. */
export class BrokerState {
  constructor({ actions = [] } = {}) {
    this.taskGeneration = 0;
    this.privacyGeneration = 0;
    this.actions = normalizeActionMetadata(actions);
    this.catalog = new Map();
    this.grants = new Map();
    this.pending = new Map();
    this.tasks = new Map();
  }

  resetTask() {
    const result = this.#accessResetResult();
    this.taskGeneration += 1;
    this.grants.clear();
    this.pending.clear();
    this.tasks.clear();
    return result;
  }

  resetPrivacy() {
    const result = this.#accessResetResult();
    this.privacyGeneration += 1;
    this.catalog.clear();
    this.grants.clear();
    this.pending.clear();
    return result;
  }

  #accessResetResult() {
    return {
      pendingRequestIds: [...this.pending.keys()],
      revokedGrants: [...this.grants.values()].map(({ taskId, actionId }) => ({ taskId, actionId }))
    };
  }

  registerTask({ taskId, frequencyMs = null, actions = [] } = {}) {
    const id = normalizeIdentifier(taskId, LIMITS.taskIdLength);
    if (!id || id !== taskId || !validFrequency(frequencyMs)
      || !Array.isArray(actions) || actions.length > LIMITS.taskActions) {
      return { ok: false, error: "invalid_task_registration" };
    }
    const normalizedActions = actions.map((actionId) => normalizeIdentifier(actionId, LIMITS.actionIdLength));
    if (normalizedActions.some((actionId, index) => !actionId
      || actionId !== actions[index]
      || !this.actions.has(actionId))
      || new Set(normalizedActions).size !== normalizedActions.length) {
      return { ok: false, error: "invalid_task_actions" };
    }
    // A task registration is an immutable declaration for this frame session.
    // Reusing an id must not mutate the action set behind an existing grant.
    if (this.tasks.has(id)) {
      return { ok: false, error: "duplicate_task_registration" };
    }
    if (this.tasks.size >= LIMITS.registeredTasks) {
      return { ok: false, error: "too_many_registered_tasks" };
    }
    this.tasks.set(id, { frequencyMs, actions: Object.freeze(normalizedActions) });
    return { ok: true, taskId: id, frequencyMs, actions: normalizedActions };
  }

  unregisterTask(taskId) {
    const id = normalizeIdentifier(taskId, LIMITS.taskIdLength);
    if (!id || !this.tasks.delete(id)) return false;
    for (const [key, grant] of this.grants) {
      if (grant.taskId === id) this.grants.delete(key);
    }
    for (const [requestId, request] of this.pending) {
      if (request.taskId === id) this.pending.delete(requestId);
    }
    return true;
  }

  setCatalog(entries) {
    if (!Array.isArray(entries) || entries.length > LIMITS.catalogEntries) {
      return { ok: false, error: "invalid_catalog", changed: false, revokedGrants: [] };
    }

    const nextCatalog = new Map();
    for (const entry of entries) {
      const validated = validateKey(entry?.key);
      if (!validated.ok || !validRevision(entry?.revision) || !ENTRY_KINDS.has(entry?.kind)
        || nextCatalog.has(validated.key)) {
        return { ok: false, error: "invalid_catalog", changed: false, revokedGrants: [] };
      }
      nextCatalog.set(validated.key, Object.freeze({ revision: entry.revision, kind: entry.kind }));
    }

    let changed = nextCatalog.size !== this.catalog.size;
    if (!changed) {
      for (const [key, entry] of nextCatalog) {
        const previous = this.catalog.get(key);
        if (previous?.revision !== entry.revision || previous?.kind !== entry.kind) {
          changed = true;
          break;
        }
      }
    }

    const revokedGrants = [];
    for (const [key, grant] of this.grants) {
      if (!grant.entries.every((entry) => {
        const current = nextCatalog.get(entry.key);
        return current?.revision === entry.revision && current.kind === entry.kind;
      })) {
        this.grants.delete(key);
        revokedGrants.push({ taskId: grant.taskId, actionId: grant.actionId });
      }
    }

    this.catalog = nextCatalog;
    return { ok: true, changed, revokedGrants };
  }

  request({ requestId, taskId, actionId, input } = {}) {
    if (!validRequestId(requestId)) return { kind: "rejected", error: "invalid_request" };
    if (this.pending.has(requestId)) return { kind: "rejected", error: "duplicate_request" };

    const normalizedTaskId = normalizeIdentifier(taskId, LIMITS.taskIdLength);
    const normalizedActionId = normalizeIdentifier(actionId, LIMITS.actionIdLength);
    if (normalizedTaskId !== taskId || normalizedActionId !== actionId) {
      return { kind: "rejected", error: "invalid_request" };
    }
    const task = normalizedTaskId ? this.tasks.get(normalizedTaskId) : null;
    const action = normalizedActionId ? this.actions.get(normalizedActionId) : null;
    if (!task) return { kind: "rejected", error: "unknown_task" };
    if (!action || !task.actions.includes(normalizedActionId)) {
      return { kind: "rejected", error: "action_not_declared" };
    }
    if (!validInput(input)) return { kind: "rejected", error: "invalid_input" };
    for (const pending of this.pending.values()) {
      if (pending.taskId === normalizedTaskId && pending.actionId === normalizedActionId) {
        return { kind: "rejected", error: "action_in_flight" };
      }
    }

    const existingGrant = this.grants.get(grantKey(normalizedTaskId, normalizedActionId));
    if (existingGrant && this.#grantIsCurrent(existingGrant)) {
      return {
        kind: "granted",
        taskId: normalizedTaskId,
        actionId: normalizedActionId,
        input,
        entries: existingGrant.entries
      };
    }
    if (this.pending.size >= LIMITS.pendingRequests) {
      return { kind: "rejected", error: "too_many_pending_requests" };
    }

    const missingKeys = this.#missingKeys(action);
    this.pending.set(requestId, {
      taskId: normalizedTaskId,
      actionId: normalizedActionId,
      input,
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration
    });
    return {
      kind: "pending",
      taskId: normalizedTaskId,
      actionId: normalizedActionId,
      missingKeys
    };
  }

  approve(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "unknown_request" };
    if (request.taskGeneration !== this.taskGeneration
      || request.privacyGeneration !== this.privacyGeneration) {
      this.pending.delete(requestId);
      return { ok: false, error: "stale_request" };
    }

    const action = this.actions.get(request.actionId);
    const entries = this.#resolvedEntries(action);
    if (!entries.ok) return entries;

    const grant = Object.freeze({
      taskId: request.taskId,
      actionId: request.actionId,
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration,
      entries: entries.entries
    });
    this.grants.set(grantKey(request.taskId, request.actionId), grant);

    const requestIds = [];
    for (const [candidateId, candidate] of this.pending) {
      if (candidate.taskId === request.taskId
        && candidate.actionId === request.actionId
        && candidate.taskGeneration === this.taskGeneration
        && candidate.privacyGeneration === this.privacyGeneration) {
        requestIds.push(candidateId);
        this.pending.delete(candidateId);
      }
    }

    return {
      ok: true,
      taskId: request.taskId,
      actionId: request.actionId,
      entries: entries.entries,
      requestIds
    };
  }

  deny(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "unknown_request" };
    this.pending.delete(requestId);
    return {
      ok: true,
      requestId,
      taskId: request.taskId,
      actionId: request.actionId
    };
  }

  revoke(taskId, actionId) {
    return this.grants.delete(grantKey(taskId, actionId));
  }

  #missingKeys(action) {
    const missing = [];
    for (const binding of action.requiredEntries) {
      const entry = this.catalog.get(binding.key);
      if (!entry || !binding.kinds.includes(entry.kind)) missing.push(binding.key);
    }
    return missing;
  }

  #resolvedEntries(action) {
    const entries = [];
    for (const binding of action.requiredEntries) {
      const entry = this.catalog.get(binding.key);
      if (!entry) return { ok: false, error: "missing_entry" };
      if (!binding.kinds.includes(entry.kind)) return { ok: false, error: "entry_kind_denied" };
      entries.push(Object.freeze({
        slot: binding.slot,
        key: binding.key,
        kinds: binding.kinds,
        revision: entry.revision,
        kind: entry.kind
      }));
    }
    return { ok: true, entries: Object.freeze(entries) };
  }

  #grantIsCurrent(grant) {
    return grant.taskGeneration === this.taskGeneration
      && grant.privacyGeneration === this.privacyGeneration
      && grant.entries.every((entry) => {
        const current = this.catalog.get(entry.key);
        return current?.revision === entry.revision && current.kind === entry.kind;
      });
  }

  snapshot() {
    const byKey = ([left], [right]) => left.localeCompare(right);
    return {
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration,
      tasks: [...this.tasks.entries()]
        .sort(byKey)
        .map(([taskId, task]) => ({ taskId, ...task })),
      catalog: [...this.catalog.entries()]
        .sort(byKey)
        .map(([key, entry]) => ({ key, ...entry })),
      grants: [...this.grants.values()]
        .sort((left, right) => grantKey(left.taskId, left.actionId).localeCompare(grantKey(right.taskId, right.actionId)))
        .map((grant) => ({ ...grant })),
      pending: [...this.pending.entries()].map(([requestId, request]) => ({
        requestId,
        ...request,
        missingKeys: this.#missingKeys(this.actions.get(request.actionId))
      }))
    };
  }
}
