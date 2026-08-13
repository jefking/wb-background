# Window Broker

A small, dependency-free experiment in browser-owned permissions for JavaScript background tasks.

The host page contains two isolated frames:

- A **task frame** that runs a five-second heartbeat and asks for `demo.secret`.
- A **privacy frame** that stores key/value secrets in memory.

The host sees secret names and access requests. It can approve, deny, and revoke access, but successful secret values travel directly from the privacy frame to the task over a one-shot `MessagePort`.

## Run it

Node 20 or newer is required.

```sh
npm start
```

Open <http://127.0.0.1:8000>, add `demo.secret` in the right frame, and approve the request shown by the host. Run the dependency-free tests with:

```sh
npm test
```

The launcher serves three distinct browser origins from one Node process:

| Role | URL |
| --- | --- |
| Trusted host | `http://127.0.0.1:8000` |
| Sample task | `http://127.0.0.1:8001` |
| Memory privacy provider | `http://127.0.0.1:8002` |

## Permission model

- A grant is bound to the current task document, current privacy document, key, and key revision.
- Reloading or swapping either frame clears grants and pending requests.
- Updating or deleting a secret changes its revision and revokes its grant.
- Denial rejects only the current request. Approval grants future reads until revocation or a lifecycle reset.
- Secret values are memory-only. Reloading the privacy frame erases them.
- The task receives plaintext after approval. Revocation cannot erase a value it already received or prevent a hostile approved task from transmitting it.

The task iframe uses a separate tuple origin and an exact-origin connection. The privacy iframe intentionally uses an opaque sandbox origin, so even a task that navigates itself to the privacy provider’s URL cannot gain same-origin DOM access to the vault. Its initial connection is bound to its exact `WindowProxy`, a trusted-parent check, and a freshly transferred capability port.

## WB/v1 replacement-frame protocol

The URL controls can load other HTTP(S) components as long as the host, task, and privacy URLs all have distinct origins. A replacement server must permit framing by `http://127.0.0.1:8000`.

After a frame load, the host transfers a dedicated control port in this window message:

```js
{
  type: "wb.connect",
  protocol: 1,
  role: "task" | "privacy",
  expectedOrigin: "https://component.example",
  port: MessagePort
}
```

Frames must validate `event.source === window.parent` and the host origin before accepting the port. They then send `task.ready` or `privacy.ready` with `protocol: 1` over it.

A task requests a key by transferring a new one-shot reply port over its control port:

```js
{
  type: "secret.request",
  protocol: 1,
  requestId: "unique-within-this-document",
  key: "demo.secret",
  replyPort: MessagePort
}
```

The privacy provider publishes names and positive integer revisions—never values—to the host:

```js
{
  type: "privacy.catalog",
  protocol: 1,
  entries: [{ key: "demo.secret", revision: 1 }]
}
```

Once approved, the host transfers the task’s reply port to the privacy provider:

```js
{
  type: "secret.resolve",
  protocol: 1,
  requestId: "...",
  key: "demo.secret",
  revision: 1,
  replyPort: MessagePort
}
```

The privacy frame answers the task directly with `{ type: "secret.result", protocol: 1, ok: true, value }`, or with `{ ..., ok: false, error: { code, message } }`. The host never installs a listener on a successful reply path.
