# Window Broker SDK proof of concept

A dependency-free experiment in browser-owned permissions for scheduled JavaScript or TypeScript tasks. The app keeps its security boundary—the host approves access while secret values travel directly from the vault frame to a task—but the reusable behavior now lives in small SDK modules.

## Modules

- `src/runtime-sdk` registers and runs task functions, schedules non-overlapping runs, publishes their frequency to the host, and gives every run a `getSecret` hook. `index.d.ts` supplies TypeScript types.
- `src/vault-sdk` provides a page-memory `MemoryVault` plus the `VaultProvider` that publishes key/revision metadata and resolves approved secret requests. Values disappear when the page reloads.
- `src/task-example` is the minimal five-second heartbeat example used by the task frame.

The public task and privacy pages are deliberately thin adapters. The server exposes only the required SDK entrypoints on their respective component origins; SDK test files are not served.

## Register a task

```js
import { createTaskRuntime } from "../runtime-sdk/index.js";

const runtime = createTaskRuntime({ trustedHostOrigin: "http://127.0.0.1:8000" });
runtime.registerTask({
  id: "heartbeat",
  frequencyMs: 5_000,
  async run({ getSecret }) {
    const secret = await getSecret("demo.secret");
    console.log(`heartbeat called with a ${secret.length}-character secret`);
  }
});
```

Scheduled tasks run once when the broker connects and then at `frequencyMs`. A run is never overlapped by its next timer tick. Omit `frequencyMs` to create a manual task and invoke the returned controller’s `runNow()` method.

## Use the in-memory vault

```js
import { MemoryVault, VaultProvider } from "../vault-sdk/index.js";

const vault = new MemoryVault();
new VaultProvider({
  vault,
  trustedHostOrigin: "http://127.0.0.1:8000"
}).listen();

vault.save("demo.secret", "swordfish");
vault.get("demo.secret");
vault.delete("demo.secret");
```

Every save gets a new revision, including updates to an existing key. Catalog changes automatically invalidate revision-bound grants in the host.

## Run it

Node 20 or newer is required.

```sh
npm start
```

Open <http://127.0.0.1:8000>, save `demo.secret` in the vault frame, and approve the heartbeat request. The example reports completed runs in the task frame’s browser console without printing the secret value.

Run all unit and integration tests with:

```sh
npm test
```

The launcher serves three distinct browser origins from one Node process:

| Role | URL |
| --- | --- |
| Trusted host | `http://127.0.0.1:8000` |
| Sample task | `http://127.0.0.1:8001` |
| Memory vault provider | `http://127.0.0.1:8002` |

## Permission model

- A grant is bound to the current task document, current vault document, key, and key revision.
- Reloading or swapping either frame clears grants and pending requests.
- Updating or deleting a secret changes its revision and revokes its grant.
- Denial rejects only the current request. Approval grants future reads until revocation or a lifecycle reset.
- Secret values are memory-only. Reloading the vault frame erases them.
- The task receives plaintext after approval. Revocation cannot erase a value it already received or prevent a hostile approved task from transmitting it.

The task iframe uses a separate tuple origin and an exact-origin connection. The vault iframe intentionally uses an opaque sandbox origin, so even a task that navigates itself to the vault provider’s URL cannot gain same-origin DOM access. Its initial connection is bound to its exact `WindowProxy`, a trusted-parent check, and a freshly transferred capability port.

## WB/v1 messages

After a frame load, the host transfers a dedicated control port in a `wb.connect` message. The runtime answers with `task.ready`, then publishes each task as:

```js
{
  type: "task.register",
  protocol: 1,
  taskId: "heartbeat",
  frequencyMs: 5000 // null for a manual task
}
```

A task requests a key with a new one-shot reply port. The vault publishes names and positive revisions—never values—to the host. Once access is approved, the host transfers that reply port to the vault; the vault sends the result directly to the task. The host never installs a listener on a successful secret-value path.
