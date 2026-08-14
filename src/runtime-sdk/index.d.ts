export const PROTOCOL_VERSION: 1;

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface TaskContext {
  getSecret(key: string): Promise<string>;
}

export interface TaskDefinition {
  id: string;
  run(context: TaskContext): void | Promise<void>;
  frequencyMs?: number;
}

export interface TaskController {
  readonly id: string;
  readonly frequencyMs: number | null;
  runNow(): Promise<void>;
  unregister(): boolean;
}

export interface TaskRuntimeOptions {
  trustedHostOrigin: string;
  windowTarget?: Window;
  messageChannelFactory?: () => MessageChannel;
  setIntervalFn?: (callback: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  onTaskError?: (error: unknown, taskId: string) => void;
  onConnectionChange?: (state: { connected: boolean; reason?: string }) => void;
}

export class TaskRuntime {
  constructor(options: TaskRuntimeOptions);
  listen(windowTarget?: Window): this;
  stopListening(): void;
  handleWindowMessage(event: MessageEvent): boolean;
  connect(port: MessagePort): this;
  registerTask(definition: TaskDefinition): TaskController;
  unregisterTask(id: string): boolean;
  runTask(id: string): Promise<void>;
  getSecret(key: string): Promise<string>;
  destroy(): void;
}

export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime;
