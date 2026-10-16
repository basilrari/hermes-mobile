# Room read cursors (feature `read_cursors`)

Status: **proposed for gate G0**. Not signed off.

Grounded in NousResearch/hermes-agent `4e59ac2b`. `groups.read` does not exist. `groups.list` / `groups.state` do not return `read_seq` or `unread_count`.

## What exists today

Sessions already have one global watermark:

- Column `sessions.last_read_at` (`hermes_state_common.py`, `CREATE TABLE sessions`).
- `hermes_state_sessions.py:SessionDB.set_session_read` writes `time.time()` for read and `0.0` for unread, across the compression lineage. `session_unread`: NULL means read; unread when activity is later than the watermark.
- `PATCH /api/sessions/{session_id}` accepts `unread: true/false` (`hermes_cli/web_routers/sessions.py:rename_session_endpoint`). It is not per device.
- `tui_gateway/change_watcher.py` includes `last_read_at` in `_SESSION_SIGNATURE_FIELDS`, so a read pushes `sessions.changed`.

Rooms have no equivalent. `gateway/hosted_rooms.py` schema (`_SCHEMA_DDL`) has rooms, events, links, leases are next door in `hosted_room_driver.py`. No read table.

The product rule (plan decision 4): read on one device means read everywhere. One watermark per room, same idea as `last_read_at`, not a copy of its column type. Room position is a log seq, not a timestamp.

## Wire shape

### `groups.read`

Request params:

```json
{"room_id": "room_123", "seq": 40, "device_id": "optional-uuid"}
```

| Field | Required | Rule |
|---|---|---|
| `room_id` | yes | Same id rules as `groups.state`. |
| `seq` | yes | Integer ≥ 0. The caller's last seen `hosted_room_events.seq`. |
| `device_id` | no | Accepted and **ignored** for the watermark. Read state is not keyed by device. Present so HM-23 can send the bridge id without a second round trip. Not stored. |

Result:

```json
{"read_seq": 40}
```

`read_seq` is the watermark after the call (the max of the stored value and a valid `seq`).

Storage, in `shared-state.db` (same file as `default_db_path()`):

```sql
CREATE TABLE hosted_room_read_cursors (
    room_id TEXT PRIMARY KEY,
    read_seq INTEGER NOT NULL CHECK (read_seq >= 0),
    updated_at REAL NOT NULL,
    FOREIGN KEY (room_id) REFERENCES hosted_rooms(room_id)
);
```

No `device_id` column. Update in one immediate transaction, same style as `append_event`: read the room, reject a missing or disbanded room, reject `seq` above `latest_seq`, then move `read_seq` forward only.

### Fields on existing methods

When `read_cursors` is advertised, `groups.list` rooms and `groups.state`'s `room` object gain:

| Field | Type | Meaning |
|---|---|---|
| `read_seq` | int ≥ 0 | Stored watermark. `0` when no row exists yet (nothing read). |
| `unread_count` | int ≥ 0 | Count of `hosted_room_events` for that room with `seq > read_seq` and `kind IN ('message.user', 'message.member')`. |

`unread_count` counts only those two kinds (`gateway/hosted_rooms.py:_EVENT_KINDS_BY_ACTOR`: user and member messages). Control and turn events (`authority.claimed`, `turn.started`, `room.renamed`, …) do not badge. The plan names `unread_count` and does not define the set; this is the frozen set.

A missing cursor row is `read_seq: 0`, so a new room shows every message unread until something calls `groups.read`. NULL-as-read (the session rule) is **not** reused: rooms have never had a watermark, and treating history as already read would hide it.

### Push

After a watermark **moves forward**, the dashboard emits `groups.event` with `kind: "read"` (see `groups-event.md`). A no-op call emits nothing.

## Errors

Same envelope as `groups.state` / `groups.log` (`tui_gateway/methods_groups.py:_room_method` → `server.py:_err`).

Proposed codes (unused on `4e59ac2b`; `4119` is already `groups.demote`):

| Case | Code | Message |
|---|---|---|
| Room missing or disbanded | `4124` | the `RoomNotFoundError` text `groups.state` would use |
| `seq` is not an integer ≥ 0, or `seq` > `latest_seq` | `4124` | `seq is ahead of the hosted room log` when it is ahead; `seq must be a nonnegative integer` otherwise |
| Anything else | `5122` | the exception text |

Stock gateway: the method is not registered. `tui_gateway/rpc_dispatch.py` returns `-32601` `unknown method`. Clients must not call `groups.read` unless `read_cursors` is in `features`.

`device_id` of the wrong type is ignored, not an error. The field is not part of the watermark.

Idempotency: `seq` less than or equal to the stored `read_seq` returns the stored value and does not write. Repeating the same `seq` is a no-op.

## Feature flag

String `read_cursors` in `groups.capabilities.features`.

Absent: `groups.list` / `groups.state` omit `read_seq` and `unread_count`. Clients show no room badge and do not call `groups.read`. Extra fields, when present, are ignored by older clients (they already read named fields off the room object).

`groups.read` is a database read/write. It does not require the hosted-room service (`service_code` is not used). `groups.log` is the pattern, not `groups.send`.

## Ordering and duplication

- `read_seq` only moves forward. Two devices racing `groups.read` keep the higher seq. The lower call returns the higher watermark.
- `unread_count` is derived from the log and the watermark inside the same transaction as the read of those rows. A `groups.event` `kind: "log"` can increase it; `kind: "read"` can decrease it. Clients refetch; they do not decrement locally from the hint alone (the hint has no count).
- A `groups.read` that lands before the client has fetched the new log still returns `read_seq`. It cannot move past `latest_seq`.

## Restart and epoch

The row lives in `shared-state.db`, so it survives a restart of either process. `read_seq` does not reset when `authority_epoch` increments or when `replay_epoch` changes.

`authority_epoch` is not part of the watermark. After a takeover the seq space is the same log (`claim_authority` does not delete events).

Session read state is unchanged: still `PATCH` `unread` and `sessions.changed`.

## Dashboard and the messaging gateway

The app talks to `hermes dashboard`. `groups.read` runs on that process and writes `shared-state.db`. The messaging gateway reads the same file for its driver. It does not need to serve `groups.read` (Telegram is not a room client).

Two writers on the cursor row are safe only because the update is a compare-and-swap inside one transaction (`read_seq = max(read_seq, seq)` fenced on the previous value). Do not read-modify-write from Python without that fence. `append_event`'s `_fenced_update` is the pattern.

The `kind: "read"` hint is broadcast by the dashboard watcher (see `groups-event.md`), including when the write happened in the dashboard process itself. Do not rely on the messaging gateway to push it.
