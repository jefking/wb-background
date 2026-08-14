export const PROTOCOL_VERSION: 1;
export const VAULT_LIMITS: Readonly<{ keys: number; keyLength: number; valueLength: number }>;

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface CatalogEntry {
  readonly key: string;
  readonly revision: number;
}

export type VaultChange =
  | { type: "saved"; key: string; revision: number }
  | { type: "deleted"; key: string }
  | { type: "cleared" };

export class MemoryVault {
  save(key: string, value: string): Readonly<CatalogEntry>;
  get(key: string): string | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): boolean;
  catalog(): CatalogEntry[];
  resolve(key: string, revision: number):
    | { ok: true; value: string }
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
