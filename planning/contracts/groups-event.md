# `groups.event` (feature `event_push`)

Status: **proposed for gate G0**. Not signed off.

Grounded in NousResearch/hermes-agent `4e59ac2b` (main on 2026-10-16). The plan was written against `acc3cada`; that short SHA was not on this clone. The functions below are the ones read at `4e59ac2b`.

This method does not exist yet. `groups.capabilities` (`tui_gateway/methods_groups.py`, the `groups.capabilities` handler) returns a fixed `features` list and does not include `event_push`.

## What exists today

- Room log seq is durable. `gateway/hosted_rooms.py:append_event` allocates `seq` from `hosted_rooms.next_seq` inside one immediate transaction, then advances `next_seq`. `read_events(since_seq, limit)` returns events with `seq > since_seq`, plus `latest_seq` (`next_seq - 1`) and `authority` `{gateway_id, epoch}`. `since_seq` past `latest_seq` raises `HostedRoomError` with the message `since_seq is ahead of the hosted room log`. `groups.log` maps that to JSON-RPC error `4112` (`tui_gateway/methods_groups.py`).
- `PROTOCOL_VERSION` is `2`. `MAX_LOG_LIMIT` is `500`.
- There is no room push. The renderer polls every 2 seconds and re-reads the log from `since_seq: 0` (`apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx`, `refresh` / `poll`, both in this repo and the same file on upstream `4e59ac2b`).
- Global pushes already exist for sessions. `tui_gateway/change_watcher.py:_broadcast_watched_changes` calls `tui_gateway/server.py:_broadcast_global_event`. `sessions.changed` is checked every 0.5 s and coalesced with `_CHANGE_BROADCAST_FLOOR_S` of 2.0 s (a burst keeps the old signature and fires once when the window opens, so the trailing change is not dropped). The signature includes `last_read_at`.
- `_broadcast_global_event` only writes to transports registered in **this process** (`_live_transports`). With no client, a dashboard process drops the frame (stdout is a log). It does not cross into the other Hermes process.
- The frame helper is `_event_frame(event, sid, payload)` in `tui_gateway/server.py`. It produces a JSON-RPC **notification** (`method` is `event`, no `id`):

  ```json
  {"jsonrpc":"2.0","method":"event","params":{"type":"<event>","session_id":"","payload":{}}}
  ```

  `sessions.changed` is `type: "sessions.changed"` with an empty payload. `groups.event` uses that same envelope. The plan's `{room_id, latest_seq, kind, epoch}` is the **payload**, not a new JSON-RPC method name.
- `tui_gateway/event_replay.py:_stamp_event` skips frames with an empty `session_id`. A global event is not in the replay ring. `session.events.since` will not replay `groups.event`. A missed hint is recovered by polling, which is what "hint only" means.

## Wire shape

Server → client notification:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "groups.event",
    "session_id": "",
    "payload": {
      "room_id": "room_123",
      "latest_seq": 40,
      "kind": "log",
      "epoch": 1
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `room_id` | string | `hosted_rooms.room_id` |
| `latest_seq` | int ≥ 0 | Latest `hosted_room_events.seq` for that room. `0` when the room has no events. Same number as `read_events`'s `latest_seq`. |
| `kind` | `"log"` \| `"state"` \| `"read"` | What the client should refetch. See below. |
| `epoch` | int ≥ 1 | That room's `hosted_rooms.authority_epoch`. Not the session replay epoch. |

No other payload fields. The hint does not carry message text, the read cursor, or a pid.

Client reaction:

| `kind` | Refetch |
|---|---|
| `log` | `groups.log` with `since_seq` = the last seq this client has applied for this room |
| `state` | `groups.state` and `groups.log` from that same cursor |
| `read` | `groups.state` (for `read_seq` / `unread_count` once `read_cursors` exists). Do not assume the log grew. |

`kind: "state"` covers a room-row change (name, members, `authority_epoch`, disband). An implementer that only ever emits `log` and `read` is wrong: an authority change with no new message the user cares about still has to wake `groups.state`. Emitting `state` when a message also landed is allowed; the client then fetches both.

## Errors

The notification has no `id` and no error response. Callers do not invoke `groups.event`.

A stock gateway has no `event_push` feature and never sends `type: "groups.event"`. Sending it without advertising the feature is a bug.

`groups.log` errors stay as they are (`4112` for a hosted-room error, `5113` for anything else). The one the client must handle: `since_seq is ahead of the hosted room log` means the cursor is not for this database. Refetch from `since_seq: 0` only in that case.

## Feature flag

Add the string `event_push` to `groups.capabilities` `features`.

Detection is `features.includes("event_push")` after the existing array check in `groupExecutionMode` (`apps/desktop/src/plugins/hermes-bots/canonical-group-capabilities.ts`). Unknown feature strings must not flip the mode to `unavailable` (today a non-string entry does; a new string does not).

Flag absent: keep today's poll. Flag present: follow hints, and keep a slow poll so a missed hint still lands. The slow period is chosen in HM-20. It must not be the current 2 s full-log reread from `since_seq: 0`.

## Ordering and duplication

- Hints for one room may repeat. Applying `groups.log` from the last applied seq is idempotent (`append_event` also dedupes on `event_id`).
- Ignore a hint whose `latest_seq` is less than or equal to the seq already applied for that room.
- Hints for different rooms are independent.
- One WebSocket does not reorder frames from one writer. The client still uses `latest_seq`, not arrival order, so a coalesced hint that jumps the seq is fine.
- Coalesce like `sessions.changed`: at most one `groups.event` per room per 2 seconds, trailing edge included, so the hint carries the newest `latest_seq` of the burst. Match `change_watcher._broadcast_watched_changes` rather than inventing a second coalescer.

## Restart and epoch

Two epochs already exist. They are not interchangeable.

| Token | Where | Survives process restart? |
|---|---|---|
| `authority_epoch` | `hosted_rooms.authority_epoch` (`claim_authority` does `authority_epoch+1`; `read_events` returns it as `authority.epoch`) | Yes. Starts at 1. Increases only on a fenced takeover. |
| `replay_epoch` | `tui_gateway/event_replay.py:replay_epoch` (`uuid.uuid4().hex` at import). Returned by `session.events.since` and `gateway.ready`. | No. New value every process start. Session seq counters reset with it. |

`groups.event.payload.epoch` is **`authority_epoch`**.

`claim_authority` also advances `next_seq`. Room seq does not rewind on restart or on takeover. A client **does not** zero its room cursor when `authority_epoch` changes, and it **does not** zero it when `gateway.ready.replay_epoch` changes. Session cursors still reset when `replay_epoch` changes; that rule is only for `session.events.since`.

The plan text "reset on epoch change" (HM-20) does not hold for the room log. Resetting on `replay_epoch` would re-download a durable log after every dashboard restart. Resetting on `authority_epoch` is unnecessary because seq does not rewind. The only full refetch is the `since_seq is ahead` error above.

## Dashboard and the messaging gateway

Both processes start a room driver on the same file:

- `hermes dashboard`: `hermes_cli/web_server_app.py` starts `tui_gateway/methods_groups.py:start_hosted_room_service`.
- `hermes gateway`: `gateway/run_startup.py:_start_hosted_room_worker_sync` starts the same service.

The database is `gateway/hosted_rooms.py:default_db_path`: the root `shared-state.db` (a profile home under `profiles/` resolves to the install root, not that profile's `state.db`). The module docstring that says the root `state.db` is stale; `default_db_path` is the code.

`local_authority_gateway_id()` is the install id, so both processes share one gateway id. The driver lease (`gateway/hosted_room_driver.py:acquire_lease`) is per room and is held by an in-memory `process_generation` (`tui_gateway/hosted_room_driver.py:HostedRoomRuntime`, `uuid` hex). A second live generation gets `LeaseHeldError` until the lease expires or is released. That fences **task execution**. It does not deliver WebSocket events.

`groups.event` has to be produced by the **dashboard** process, the one that holds the app's WebSocket. It watches `shared-state.db` the way `_sessions_sig` watches `state.db` (read-only, content signature, not the WAL mtime alone). The messaging gateway may append the event; its own `_broadcast_global_event` does not reach the app. The watcher must run even when this process does not hold the lease.
