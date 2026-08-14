export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  keyLength: 128,
  requestIdLength: 96,
  taskIdLength: 96,
  registeredTasks: 32,
  pendingRequests: 32,
  catalogEntries: 128
});

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

function validRequestId(requestId) {
  return typeof requestId === "string"
    && requestId.length > 0
    && requestId.length <= LIMITS.requestIdLength;
}

function validRevision(revision) {
  return Number.isSafeInteger(revision) && revision > 0;
}

function normalizeTaskId(taskId) {
  if (typeof taskId !== "string") return null;
  const normalized = taskId.trim();
  return normalized.length > 0 && normalized.length <= LIMITS.taskIdLength ? normalized : null;
}

function validFrequency(frequencyMs) {
  return frequencyMs === null || (Number.isSafeInteger(frequencyMs) && frequencyMs > 0);
}

export class BrokerState {
  constructor() {
    this.taskGeneration = 0;
    this.privacyGeneration = 0;
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
      revokedKeys: [...this.grants.keys()]
    };
  }

  registerTask({ taskId, frequencyMs = null } = {}) {
    const id = normalizeTaskId(taskId);
    if (!id || !validFrequency(frequencyMs)) {
      return { ok: false, error: "invalid_task_registration" };
    }
    if (!this.tasks.has(id) && this.tasks.size >= LIMITS.registeredTasks) {
      return { ok: false, error: "too_many_registered_tasks" };
    }
    this.tasks.set(id, { frequencyMs });
    return { ok: true, taskId: id, frequencyMs };
  }

  unregisterTask(taskId) {
    const id = normalizeTaskId(taskId);
    return id ? this.tasks.delete(id) : false;
  }

  setCatalog(entries) {
    if (!Array.isArray(entries) || entries.length > LIMITS.catalogEntries) {
      return { ok: false, error: "invalid_catalog", revokedKeys: [] };
    }

    const nextCatalog = new Map();
    for (const entry of entries) {
      const validated = validateKey(entry?.key);
      if (!validated.ok || !validRevision(entry?.revision) || nextCatalog.has(validated.key)) {
        return { ok: false, error: "invalid_catalog", revokedKeys: [] };
      }
      nextCatalog.set(validated.key, entry.revision);
    }

    const revokedKeys = [];
    for (const [key, grant] of this.grants) {
      if (nextCatalog.get(key) !== grant.revision) {
        this.grants.delete(key);
        revokedKeys.push(key);
      }
    }

    this.catalog = nextCatalog;
    return { ok: true, revokedKeys };
  }

  request({ requestId, key }) {
    if (!validRequestId(requestId)) {
      return { kind: "rejected", error: "invalid_request" };
    }

    const validated = validateKey(key);
    if (!validated.ok) return { kind: "rejected", error: validated.error };
    if (this.pending.has(requestId)) return { kind: "rejected", error: "duplicate_request" };

    const revision = this.catalog.get(validated.key);
    const grant = this.grants.get(validated.key);
    if (revision !== undefined
      && grant?.revision === revision
      && grant.taskGeneration === this.taskGeneration
      && grant.privacyGeneration === this.privacyGeneration) {
      return { kind: "granted", key: validated.key, revision };
    }

    if (this.pending.size >= LIMITS.pendingRequests) {
      return { kind: "rejected", error: "too_many_pending_requests" };
    }

    this.pending.set(requestId, {
      key: validated.key,
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration
    });
    return { kind: "pending", key: validated.key };
  }

  approve(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "unknown_request" };
    if (request.taskGeneration !== this.taskGeneration
      || request.privacyGeneration !== this.privacyGeneration) {
      this.pending.delete(requestId);
      return { ok: false, error: "stale_request" };
    }

    const revision = this.catalog.get(request.key);
    if (revision === undefined) return { ok: false, error: "missing_key" };

    this.grants.set(request.key, {
      revision,
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration
    });

    const requestIds = [];
    for (const [candidateId, candidate] of this.pending) {
      if (candidate.key === request.key
        && candidate.taskGeneration === this.taskGeneration
        && candidate.privacyGeneration === this.privacyGeneration) {
        requestIds.push(candidateId);
        this.pending.delete(candidateId);
      }
    }

    return { ok: true, key: request.key, revision, requestIds };
  }

  deny(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "unknown_request" };
    this.pending.delete(requestId);
    return { ok: true, requestId, key: request.key };
  }

  revoke(key) {
    return this.grants.delete(key);
  }

  snapshot() {
    const byKey = ([left], [right]) => left.localeCompare(right);
    return {
      taskGeneration: this.taskGeneration,
      privacyGeneration: this.privacyGeneration,
      tasks: [...this.tasks.entries()]
        .sort(byKey)
        .map(([taskId, task]) => ({ taskId, ...task })),
      catalog: [...this.catalog.entries()].sort(byKey).map(([key, revision]) => ({ key, revision })),
      grants: [...this.grants.entries()].sort(byKey).map(([key, grant]) => ({ key, ...grant })),
      pending: [...this.pending.entries()].map(([requestId, request]) => ({ requestId, ...request }))
    };
  }
}
