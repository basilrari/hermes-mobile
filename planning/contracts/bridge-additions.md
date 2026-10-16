# Bridge additions

Status: **proposed for gate G0**. Not signed off.

The gateway flags for the new behaviour are `event_push`, `read_cursors`, and `device_cursors` (`groups-event.md`, `read-cursors.md`, `device-identity.md`). This file is the `window.hermesDesktop` surface the renderer already branches on. It is not a JSON-RPC method.

Grounded in NousResearch/hermes-agent [`4e59ac2b883b4133ea8a2d299abac45189781c09`](https://github.com/NousResearch/hermes-agent/commit/4e59ac2b883b4133ea8a2d299abac45189781c09) [`preload.ts` L432-L437](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/apps/desktop/electron/preload.ts#L432-L437) and [`global.d.ts` L432-L442](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/apps/desktop/src/global.d.ts#L432-L442). Line 431 in both files is the closing `},` of `settings`, not `preparedSubmissions`. The same block is what this repo vendors. `deviceIdentity` is not in that tree.

## What exists today

`window.hermesDesktop.preparedSubmissions` (`preload.ts`):

```ts
preparedSubmissions?: {
  read: () => Promise<string>
  update: (key: string, entry: string | null) => Promise<void>
  compareAndSet?: (
    key: string,
    expected: string | null,
    entry: string | null
  ) => Promise<{ applied: boolean; current: string | null }>
}
```

`global.d.ts` documents `compareAndSet`: replace `key` only while it holds exactly `expected` (`null` means absent). `current` is the record stored afterwards. Group send requires `compareAndSet`.

The renderer calls the native object when it is present and otherwise uses `localStorage` (`apps/desktop/src/app/session/hooks/use-prompt-actions/prepared-submissions.ts`). The mobile bridge does not implement the object today. Android killing the WebView is why HM-12 has to.

`compareAndSet` is optional in the type. `read` and `update` are required **if** the object is present.

## Wire shape

### `preparedSubmissions` (existing contract, mobile must match it)

No new fields. HM-12 implements this object. Capacitor Preferences (or write-then-rename) is behind it; the renderer never sees the backing store.

| Method | Behaviour |
|---|---|
| `read()` | Resolves to the whole journal as one JSON string. Empty journal is `"{}"`, not a rejection. |
| `update(key, entry)` | `entry === null` deletes `key`. Otherwise stores that string. |
| `compareAndSet(key, expected, entry)` | Atomic. Succeeds only when the stored string is exactly `expected` (`null` if the key is absent). `applied` is false on conflict. `current` is the value stored after the call (`null` if absent). Concurrent callers are serialised. A corrupt store fails the read path by recovering to `"{}"` rather than throwing into the send path (HM-12 tests cover this). |

The journal value is opaque to the bridge. The bridge does not parse prompts out of it and does not copy it to `localStorage`.

### `deviceIdentity` (new, optional)

```ts
deviceIdentity?: () => Promise<{ device_id: string; label: string }>
```

Rules for the two fields are in `device-identity.md`. Optional on `window.hermesDesktop`, same as `preparedSubmissions`.

Absence is not an error. HM-23: the renderer generates an id when this method is missing. HM-25: the mobile bridge provides it.

No hardware identifiers. Calling it must not prompt the user and must not hit the network.

## Errors

These are in-process. They do not use JSON-RPC codes.

| Case | Behaviour |
|---|---|
| `preparedSubmissions` missing | Renderer uses `localStorage`. Mobile must not rely on that fallback for the kill-safety HM-12 wants. |
| `compareAndSet` missing while `read` exists | Group send treats the journal as unsafe. Implement all three methods together. |
| `read()` rejects | The renderer surfaces the error on the send path. Do not reject for a missing key. |
| `deviceIdentity` missing | No throw. Caller generates a local id or skips `devices.*`. |
| `deviceIdentity()` rejects | Caller treats it as missing for that attempt. Do not retry in a loop. |

Gateway errors for `groups.read` and `devices.*` are in the other contract files. The bridge does not translate them.

## Feature flag

There is no `groups.capabilities` flag for the bridge. Detection is whether the function exists:

- `window.hermesDesktop?.preparedSubmissions?.compareAndSet`
- `window.hermesDesktop?.deviceIdentity`

Gateway flags still gate the RPCs. A bridge that exposes `deviceIdentity` does not call `devices.register` unless `device_cursors` is advertised. A renderer that sees `event_push` does not need a new bridge method; the events arrive on the WebSocket it already holds.

`read_cursors` and `event_push` likewise need no new `hermesDesktop` methods.

## Ordering and duplication

`compareAndSet` is the only ordering rule on this side. The renderer uses it so two send attempts cannot both commit the same journal key. The bridge serialises calls so two overlapping `compareAndSet`s cannot both observe the same `expected`.

`deviceIdentity` returns the same `device_id` for the life of the app data. Two overlapping calls return the same id (generate once, then read).

`groups.read`'s optional `device_id` is this `device_id` when the method exists, and omitted when it does not. Omitting it is correct: the watermark is global (`read-cursors.md`).

## Restart and epoch

The journal and the device id are on the device. A gateway restart does not clear them. An app data clear generates a new `device_id` and an empty journal.

`replay_epoch` and `authority_epoch` are gateway tokens (`groups-event.md`). The bridge does not cache them. The WebSocket client (HM-15) resets **session** replay cursors when `epoch` from `session.events.since` changes. It does not reset room `since_seq` on that change.

## Dashboard and the messaging gateway

The bridge talks only to the dashboard WebSocket (`/api/ws` after `POST /api/auth/ws-ticket`). It never opens a socket to the messaging gateway.

`preparedSubmissions` is local. It does not matter which process holds the room-driver lease.

`deviceIdentity` is local. The id is sent only to dashboard RPCs (`groups.read` as an ignored field, `devices.*` when advertised). The messaging gateway does not see it.
