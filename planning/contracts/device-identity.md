# Device identity and per-device resume cursors (feature `device_cursors`)

Status: **proposed for gate G0**. Not signed off. P2. HM-22 may drop this if upstream review pushes back; HM-25 still needs the bridge method in `bridge-additions.md`.

Grounded in NousResearch/hermes-agent [`4e59ac2b883b4133ea8a2d299abac45189781c09`](https://github.com/NousResearch/hermes-agent/commit/4e59ac2b883b4133ea8a2d299abac45189781c09). Nothing in that tree stores a device id. `git grep deviceIdentity` on `apps/desktop` at that commit finds no match. [`groups.capabilities`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L241-L244) features do not include `device_cursors`.

## What exists today

- Read state is global. Sessions: `last_read_at` (see `read-cursors.md`). Rooms: no read state. This contract does not change either.
- Resume for a **session** after a dropped socket is [`session.events.since`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_session.py#L2327-L2341). `epoch` is [`event_replay.replay_epoch()`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/event_replay.py#L48-L50), an in-process uuid. It changes on restart. The seq in that ring is not durable (`event_replay.py` module doc: counters reset; history is in `state.db`).
- Resume for a **room** is `groups.log` `since_seq`. That seq **is** durable ([`hosted_rooms.read_events`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L1163-L1212)). Page with `cursor` / `has_more` until `has_more` is false (`groups-event.md`).

Per-device state is only "reopen this device where it was". It is not unread.

## Wire shape

### Bridge (see also `bridge-additions.md`)

```ts
deviceIdentity(): Promise<{ device_id: string; label: string }>
```

| Field | Rule |
|---|---|
| `device_id` | Random UUID, version 4, canonical lowercase `8-4-4-4-12` hex. Generated once, stored in Capacitor Preferences. New value after app data is cleared. |
| `label` | Display string, default the device model, user-editable. Max 200 characters (same cap as an actor label, [`hosted_rooms.MAX_ACTOR_LABEL_CHARS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L29-L29)). |

Not a secret. Never a hardware id, serial, Android id, MAC, or IP. The server stores the string the client sends; it does not "detect" hardware ids. The app is what stops them being generated.

### Gateway

Advertised only by the feature string below. Proposed methods (new; not in `_METHODS` today):

`devices.register` params `{device_id, label}` → `{device_id, label, last_seen_at}`.

`devices.cursor.set` params `{device_id, kind, id, last_seen_seq}` → `{last_seen_seq}`.

`devices.cursor.get` params `{device_id}` → `{devices: [{kind, id, last_seen_seq, last_seen_at}]}` for that one device. No method returns every device. No method returns an IP.

| Field | Rule |
|---|---|
| `device_id` | String, 1–128 chars, charset `[A-Za-z0-9_-]` plus the UUID hyphens. `128` matches [`hosted_room_driver.MAX_IDENTIFIER_CHARS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L29-L29). The app sends a UUID; the server does not require the version nibble, so a desktop-generated id (HM-23) is the same shape. |
| `kind` | `"room"` or `"session"`. |
| `id` | Room id, or session id. |
| `last_seen_seq` | Integer ≥ 0. For `kind: "room"`, a `hosted_room_events.seq`. For `kind: "session"`, `messages.id` in that profile's `state.db` ([`hermes_state_common.py` L452-L453](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_state_common.py#L452-L453), `messages.id INTEGER PRIMARY KEY AUTOINCREMENT`). **Not** the `session.events.since` replay seq. |

Storage in `shared-state.db`:

```sql
CREATE TABLE device_resume (
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('room', 'session')),
    conversation_id TEXT NOT NULL,
    label TEXT NOT NULL,
    last_seen_seq INTEGER NOT NULL CHECK (last_seen_seq >= 0),
    last_seen_at REAL NOT NULL,
    PRIMARY KEY (device_id, kind, conversation_id)
);
```

`label` is copied onto each row by `devices.register` (update every row for that `device_id`). One table is enough; a second device table is not needed for this shape.

`last_seen_seq` only moves forward for a given primary key. A smaller seq returns the stored value and does not write.

TTL: **unfrozen (P2)**. A row whose `last_seen_at` is older than the TTL is omitted from `devices.cursor.get` and may be deleted. This gate does not pick a duration. The plan says "TTL" and does not give a number. HM-22 picks it and records the number in that PR. Leaving a guessed constant here would ship as if it had been decided.

## Contract registration

`devices.register`, `devices.cursor.set`, and `devices.cursor.get` are registered in upstream `tui_gateway/contracts` as **methods**, each with pydantic params and result models. They are not events, and they are not `groups.*` methods.

- Declare each with [`registry.method`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L63-L66) so the names land in `METHODS`.
- Register the handlers so they appear in `server._methods`. [`assert_complete`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L171-L182), called from [`test_generated.py` L96](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tests/tui_gateway/contracts/test_generated.py#L90-L96), fails if either side is missing.
- Do **not** add `devices.*` to [`_METHODS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L18-L23). That tuple is the list `groups.capabilities` advertises as its own methods. `assert_complete` compares `server._methods` with contract `METHODS`; it does not read `_METHODS`. Putting `devices.*` in the groups tuple would tell every client those names are groups methods. `groups.read` is the name that joins `_METHODS` (`read-cursors.md`).
- [`check_payload`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L155-L168) validates event payloads. These three are methods, so their pydantic params and result models are what the call path checks. They have no event payload.

## Errors

| Case | Code | Notes |
|---|---|---|
| Unknown method on a stock gateway | `-32601` | [`rpc_dispatch.py`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/rpc_dispatch.py#L17-L24). Client must feature-detect first. |
| Bad `device_id`, `kind`, `id`, or `last_seen_seq` | `4125` | Client error. Message names the field. |
| `kind: "room"` and `last_seen_seq` > that room's `latest_seq` | `4125` | Same idea as `groups.read`. |
| `kind: "session"` and the session row does not exist | `4125` | Do not create a session as a side effect. |
| Anything else | `5123` | Server error. |

`4125` and `5123` are unused in `tui_gateway/` at `4e59ac2b883b4133ea8a2d299abac45189781c09`. The grep is in `read-cursors.md`: `4124` is [`methods_prompt.py` L765](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_prompt.py#L765-L765) and `5122` is [L298 and L303](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_prompt.py#L298-L303). `groups.read` takes `4126` / `5124`. Do not reuse those.

These methods do not require the room driver service.

## Feature flag

String `device_cursors` in `groups.capabilities.features`.

The methods are `devices.*`, not `groups.*`, because a session cursor is not a room. The flag still lives on `groups.capabilities`: that is the object the app already reads (`groupExecutionMode`), and the plan puts every new flag there. A client that does not call `groups.capabilities` must treat the feature as absent.

Flag absent: do not call `devices.*`. The app still generates `device_id` locally so a later upgrade has a stable id. It does not send it.

Flag present, bridge `deviceIdentity` absent: the renderer may generate its own id (HM-23). That id is still not a hardware id.

## Ordering and duplication

- `devices.register` with the same `device_id` and a new `label` updates the label. Repeating the same pair is a no-op aside from refreshing `last_seen_at` on the device's rows (so the TTL sees the device as alive).
- `devices.cursor.set` is monotonic per `(device_id, kind, id)`. Duplicates of the same seq are no-ops.
- This cursor never changes `read_seq` or `last_read_at`.

## Restart and epoch

Rows are in `shared-state.db`. They survive a restart of `hermes dashboard` and of `hermes gateway`.

`replay_epoch` changing does not delete them and does not reset `last_seen_seq`. A client that resets its **session replay** watermark (`session.events.since`) on epoch change still keeps this resume cursor. They answer different questions: replay epoch means "the in-memory ring restarted"; the device cursor means "this device had rendered up to this durable id".

`authority_epoch` changing does not reset a room's `last_seen_seq` (seq does not rewind; see `groups-event.md`).

## Dashboard and the messaging gateway

The app's WebSocket is the dashboard. These RPCs run there. The messaging gateway does not need them (Telegram is not a resume client).

If both processes ever write `device_resume`, the forward-only update has to be a single-transaction fence, same as the read cursor. No in-memory cache is authoritative.
