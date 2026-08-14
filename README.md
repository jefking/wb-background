# Window Broker SDK proof of concept

A dependency-free WB/v2 experiment in browser-brokered, declarative actions for scheduled JavaScript or TypeScript tasks.

The Task frame never receives vault values, URLs, authentication headers, or executable Host callbacks. It can only invoke action IDs declared when the task registers. Trusted Host code owns each action's destination, method, vault bindings, input validation, timeout, response limit, and output sanitization.

## Modules

- `src/runtime-sdk` registers non-overlapping scheduled tasks and exposes `invoke(actionId, input)` to each run.
- `src/action-sdk` provides the Host-only action registry, bounded JSON validation, exact-origin JSON fetch helper, and result limits.
- `src/vault-sdk` provides memory-only `variable` and `secret` entries plus a provider that resolves revision-bound entry sets to the trusted Host.
- `src/action-example` defines the Host-owned `weather.current` action.
- `src/task-example` invokes the weather action every five seconds and renders sanitized results.

## Task SDK

Tasks send an action ID and bounded JSON data. They cannot send code, URLs, headers, callbacks, or vault keys to the Host executor.

```js
runtime.registerTask({
  id: "weather-heartbeat",
  frequencyMs: 5_000,
  actions: ["weather.current"],
  async run({ invoke }) {
    const weather = await invoke("weather.current", {});
    console.log(weather.temperatureC, weather.condition, weather.humidity);
  }
});
```

Scheduled tasks run once when the broker connects and then at `frequencyMs`. A run waiting for approval does not overlap with or queue later timer ticks.

## Trusted Host actions

The Task cannot register an action implementation. The Host builds its registry from trusted local code:

```js
const registry = new ActionRegistry();
registry.register(createWeatherAction());
```

`weather.current` is fixed to:

- action ID `weather.current`;
- vault key `weather.city`, accepted as either a variable or secret;
- `GET http://127.0.0.1:8003/weather`;
- no task-controlled input;
- no credentials, redirects, cache, or referrer;
- an eight-second Host timeout and 16 KiB response limit;
- a sanitized result containing only temperature, humidity, condition, and observation time.

The local weather service echoes the city to the Host, but the action deliberately removes it before returning data to the Task.

## Variables and secrets

The Privacy frame supports two entry kinds:

- **Variable:** visible in the Privacy UI.
- **Secret:** masked in the Privacy UI.

Both kinds are currently plaintext in page memory. “Secret” means hidden from the UI and Task, not encrypted at rest. Reloading or swapping the Privacy frame erases all entries.

Every save creates a new revision. Changing a value or switching its kind revokes grants bound to the previous revision.

## Run it

Node 20 or newer is required.

```sh
npm start
```

Open <http://127.0.0.1:8000>, then:

1. Save `weather.city` in the Privacy frame as a variable or secret.
2. Approve the pending **Read current weather** action.
3. Watch a sanitized weather result appear in the Task frame every five seconds.

Run all unit and integration tests with:

```sh
npm test
```

The launcher serves four fixed origins from one Node process:

| Role | URL |
| --- | --- |
| Trusted Host/action executor | `http://127.0.0.1:8000` |
| Sandboxed sample Task | `http://127.0.0.1:8001` |
| Sandboxed memory vault | `http://127.0.0.1:8002` |
| Constrained local weather API | `http://127.0.0.1:8003` |

## Permission model

An action grant is bound to:

- the current Task document generation;
- the registered task ID;
- the Host-owned action ID and definition;
- the current Privacy provider generation;
- every required vault key, kind, and revision.

Reloading either frame clears grants and pending requests. Updating, deleting, or changing the kind of a required entry revokes its grants. Denial rejects only the current request; the next scheduled run may request approval again.

The first invocation waits for an explicit approve or deny decision. Approval creates a reusable task/action grant, so later five-second runs execute without prompting until that grant is revoked or invalidated. Only one request for the same task/action may be pending or executing at a time, and task declarations cannot be changed by re-registering an existing ID.

The Host constrains Task and Privacy frames to fixed opaque sandbox origins. The Host CSP allows frames only from ports 8001 and 8002 and network actions only to port 8003. Component module graphs are CORS-readable because opaque sandbox documents cannot rely on same-origin module loading.

## WB/v2 flow

The Host transfers each frame a dedicated control port in a `wb.connect` message. The Task publishes its schedule and declared action IDs:

```js
{
  type: "task.register",
  protocol: 2,
  taskId: "weather-heartbeat",
  frequencyMs: 5000,
  actions: ["weather.current"]
}
```

An invocation sends bounded data and a one-shot reply port:

```js
{
  type: "action.request",
  protocol: 2,
  requestId: "action-...",
  taskId: "weather-heartbeat",
  actionId: "weather.current",
  input: {},
  replyPort
}
```

After approval, the Host resolves the action's fixed entry bindings from Privacy, executes trusted action code, and returns only a bounded action result. No Task-provided source code is evaluated and no vault value is included in an `action.result` message.

## Security boundary and limitations

- The Host and Privacy provider are trusted. WB/v2 protects vault values from Task code, not from a compromised Host.
- TypeScript types are developer ergonomics; all cross-frame data is validated again at runtime.
- The Task may retain or transmit any sanitized action result it receives. Result schemas must therefore expose only data the Task is allowed to know.
- A malicious Task may attempt confused-deputy abuse. Host actions must use fixed destinations and methods, strict input schemas, minimal credentials, quotas, and response sanitizers.
- JavaScript cannot guarantee memory zeroization. Host references to resolved strings are short-lived but not cryptographically erased.
- The five-second timer is an iframe timer and can be throttled when the browser tab is backgrounded.
