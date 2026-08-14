export const ACTION_LIMITS: Readonly<{
  actions: number;
  actionIdLength: number;
  titleLength: number;
  descriptionLength: number;
  entryBindings: number;
  slotLength: number;
  keyLength: number;
  inputBytes: number;
  outputBytes: number;
  jsonDepth: number;
  jsonNodes: number;
  jsonStringLength: number;
  vaultValueLength: number;
  responseBytes: number;
  requestBodyBytes: number;
}>;

export type VaultEntryKind = "variable" | "secret";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface RequiredEntry {
  slot: string;
  key: string;
  kinds?: VaultEntryKind[];
}

export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  destination: { origin: string; method: string; path: string };
  requiredEntries: RequiredEntry[];
  validateInput?(input: JsonValue): JsonValue | void;
  execute(context: {
    input: JsonValue;
    values: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): JsonValue | Promise<JsonValue>;
}

export function normalizeActionId(value: unknown): string;
export function cloneBoundedJson(value: unknown, options?: { maxBytes?: number }): JsonValue;

export class ActionRegistry {
  register(definition: ActionDefinition): Readonly<ActionDescription>;
  has(id: string): boolean;
  describe(id: string): Readonly<ActionDescription> | null;
  descriptions(): Readonly<ActionDescription>[];
  brokerMetadata(): Array<{ actionId: string; requiredEntries: Readonly<RequiredEntry[]> }>;
  prepareInput(id: string, input?: unknown): JsonValue;
  execute(id: string, context: {
    input?: unknown;
    values: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<JsonValue>;
}

export interface ActionDescription {
  id: string;
  title: string;
  description: string;
  destination: Readonly<{ origin: string; method: string; path: string }>;
  requiredEntries: Readonly<RequiredEntry[]>;
}

export function fetchJson(options: {
  fetchFn?: typeof fetch;
  url: string | URL;
  allowedOrigin: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}): Promise<JsonValue>;
