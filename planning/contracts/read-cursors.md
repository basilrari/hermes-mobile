# Room read cursors (feature `read_cursors`)

Status: **proposed for gate G0**. Not signed off.

Grounded in NousResearch/hermes-agent [`4e59ac2b883b4133ea8a2d299abac45189781c09`](https://github.com/NousResearch/hermes-agent/commit/4e59ac2b883b4133ea8a2d299abac45189781c09). `groups.read` does not exist. `groups.list` / `groups.state` do not return `read_seq` or `unread_count`.

## What exists today

Sessions already have one global watermark:

- Column `sessions.last_read_at` ([`hermes_state_common.py` L446](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_state_common.py#L446-L446), `CREATE TABLE sessions`).
- [`SessionDB.set_session_read`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_state_sessions.py#L1038-L1050) writes `time.time()` for read and `0.0` for unread, across the compression lineage. `session_unread`: NULL means read; unread when activity is later than the watermark.
- `PATCH /api/sessions/{session_id}` accepts `unread: true/false` ([`rename_session_endpoint`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_routers/sessions.py#L927-L934)). It is not per device.
- [`_SESSION_SIGNATURE_FIELDS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/change_watcher.py#L193-L198) includes `last_read_at`, so a read pushes `sessions.changed`.

Rooms have no equivalent. [`_SCHEMA_DDL`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L87-L131) in `gateway/hosted_rooms.py` defines `hosted_rooms`, `hosted_room_events`, and `hosted_room_links`. Leases live next door in [`gateway/hosted_room_driver.py`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L532-L567), not in that DDL. There is no read table.

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

`unread_count` counts only those two kinds ([`_EVENT_KINDS_BY_ACTOR`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L50-L57): user and member messages). Control and turn events (`authority.claimed`, `turn.started`, `room.renamed`, …) do not badge. The plan names `unread_count` and does not define the set; this is the frozen set.

A missing cursor row is `read_seq: 0`, so a new room shows every message unread until something calls `groups.read`. NULL-as-read (the session rule) is **not** reused: rooms have never had a watermark, and treating history as already read would hide it.

### Push

After a watermark **moves forward**, the dashboard emits `groups.event` with `kind: "read"` (see `groups-event.md`). A no-op call emits nothing.

## Contract registration

`groups.read` is registered in upstream `tui_gateway/contracts` as a **method**, with pydantic params and result models, and its handler is registered so [`assert_complete`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L171-L182) sees both sides.

- Add `"groups.read"` to [`_METHODS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L18-L23). That tuple is what `groups.capabilities` returns as `methods`. A handler that is not in it is invisible to clients that trust the advertisement, and a name in the tuple with no handler is a lie.
- Declare [`registry.method`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L63-L66) `("groups.read", params=GroupsReadParams, result=GroupsReadResult)` next to the other groups contracts (`tui_gateway/contracts/groups_bot_relay.py` is where `groups.log` lives). Both models are pydantic. `GroupsReadParams` is `{room_id, seq, device_id?}`; `GroupsReadResult` is `{read_seq}`.
- The handler must end up in `server._methods`. [`test_catalog_covers_the_whole_wire`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tests/tui_gateway/contracts/test_generated.py#L90-L96) fails when a registered method has no contract, and when a contract has no handler.
- [`check_payload`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L155-L168) is the event-payload gate (`groups.event`). Method params are checked on the call against the pydantic params model (unknown or mistyped keys are client error `4000`). The result model is checked on the way out.

`groups.read` is a `groups.*` method, so it belongs in `_METHODS`. `devices.*` do not; see `device-identity.md`.

## Errors

Same envelope as `groups.state` / `groups.log` ([`_room_method`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L182-L213) → `server.py:_err`).

`4119` is already [`groups.demote`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L521-L521) (`room_code=4119`). `4124` and `5122` are taken in `tui_gateway/methods_prompt.py`.

Grep of `tui_gateway/` at `4e59ac2b883b4133ea8a2d299abac45189781c09` for `\b(4124|4125|4126|5121|5122|5123|5124)\b`:

```
tui_gateway/contracts/prompt_voice.py:49:  # client dict for _turn_author answers 4124
tui_gateway/methods_prompt.py:298:        return _err(rid, 5122, _GROUP_PROBE_FAILED_MSG)
tui_gateway/methods_prompt.py:303:        return _err(rid, 5122, _GROUP_PROBE_FAILED_MSG)
tui_gateway/methods_prompt.py:765:        return _err(rid, 4124, "turn author is stamped by the gateway, never by a client")
```

`4125`, `4126`, `5121`, `5123`, and `5124` have no hits. A parse of `_err(`, `code=`, `room_code=`, and `service_code=` across `tui_gateway/*.py` shows the `41xx` block used through `4124` (then `4130`–`4132`) and the `51xx` block used through `5120` and `5122`. This contract uses the unused pair **`4126`** (client) and **`5124`** (server). `devices.*` uses `4125` / `5123`. `5121` stays unused.

| Case | Code | Message |
|---|---|---|
| Room missing or disbanded | `4126` | the `RoomNotFoundError` text `groups.state` would use |
| `seq` is not an integer ≥ 0, or `seq` > `latest_seq` | `4126` | `seq is ahead of the hosted room log` when it is ahead; `seq must be a nonnegative integer` otherwise |
| Anything else | `5124` | the exception text |

Stock gateway: the method is not registered. [`rpc_dispatch.py`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/rpc_dispatch.py#L17-L24) returns `-32601` `unknown method`. Clients must not call `groups.read` unless `read_cursors` is in `features`.

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

Two writers on the cursor row are safe only because the update is a compare-and-swap inside one transaction (`read_seq = max(read_seq, seq)` fenced on the previous value). Do not read-modify-write from Python without that fence. [`append_event`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L956-L1003)'s `_fenced_update` is the pattern.

The `kind: "read"` hint is broadcast by the dashboard watcher (see `groups-event.md`), including when the write happened in the dashboard process itself. Do not rely on the messaging gateway to push it.
