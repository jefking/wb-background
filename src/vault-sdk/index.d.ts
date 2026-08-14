export const PROTOCOL_VERSION: 2;
export const VAULT_LIMITS: Readonly<{ keys: number; keyLength: number; valueLength: number }>;

export type VaultEntryKind = "variable" | "secret";

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface CatalogEntry {
  readonly key: string;
  readonly revision: number;
  readonly kind: VaultEntryKind;
}

export type VaultChange =
  | { type: "saved"; key: string; revision: number; kind: VaultEntryKind }
  | { type: "deleted"; key: string }
  | { type: "cleared" };

export class MemoryVault {
  save(key: string, value: string, options?: { kind?: VaultEntryKind }): Readonly<CatalogEntry>;
  get(key: string): string | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): boolean;
  catalog(): CatalogEntry[];
  resolve(key: string, revision: number, acceptedKinds?: VaultEntryKind[]):
    | { ok: true; value: string; kind: VaultEntryKind }
    | { ok: false; error: { code: string; message: string } };
  resolveEntries(bindings: Array<{
    slot: string;
    key: string;
    revision: number;
    kinds: VaultEntryKind[];
  }> ):
    | { ok: true; values: Array<{ slot: string; value: string }> }
    | { ok: false; error: { code: string; message: string } };
  subscribe(listener: (change: VaultChange, catalog: CatalogEntry[]) => void): () => boolean;
}

export interface VaultProviderOptions {
  vault: MemoryVault;
  trustedHostOrigin: string;
  windowTarget?: Window;
  onConnectionChange?: (state: { connected: boolean; reason?: string }) => void;
}

export class VaultProvider {
  constructor(options: VaultProviderOptions);
  listen(windowTarget?: Window): this;
  stopListening(): void;
  handleWindowMessage(event: MessageEvent): boolean;
  connect(port: MessagePort): this;
  handleBrokerMessage(event: MessageEvent): boolean;
  sendCatalog(): boolean;
  destroy(): void;
}

export function createMemoryVault(): MemoryVault;
export function createVaultProvider(options: VaultProviderOptions): VaultProvider;
