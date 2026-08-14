export const PROTOCOL_VERSION: 2;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface TaskContext {
  invoke<TResult extends JsonValue = JsonValue>(actionId: string, input?: JsonValue): Promise<TResult>;
}

export interface TaskDefinition {
  id: string;
  run(context: TaskContext): void | Promise<void>;
  frequencyMs?: number;
  actions?: string[];
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
  invokeAction<TResult extends JsonValue = JsonValue>(
    taskId: string,
    actionId: string,
    input?: JsonValue
  ): Promise<TResult>;
  destroy(): void;
}

export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime;
