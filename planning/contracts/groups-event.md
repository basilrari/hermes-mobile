# `groups.event` (feature `event_push`)

Status: **proposed for gate G0**. Not signed off.

Grounded in NousResearch/hermes-agent [`4e59ac2b883b4133ea8a2d299abac45189781c09`](https://github.com/NousResearch/hermes-agent/commit/4e59ac2b883b4133ea8a2d299abac45189781c09) (main on 2026-10-16). The plan was written against `acc3cada`; that short SHA is not on the remote. Line numbers below are from that commit.

This method does not exist yet. [`groups.capabilities`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L216-L245) returns a fixed `features` list and does not include `event_push`.

## What exists today

- Room log seq is durable. [`append_event`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L956-L1003) allocates `seq` from `hosted_rooms.next_seq` inside one immediate transaction, then advances `next_seq`. [`read_events`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L1163-L1212) returns events with `seq > since_seq`, plus `latest_seq` (`next_seq - 1`), `cursor`, `has_more`, and `authority` `{gateway_id, epoch}`. `cursor` is the last seq on the page, or `since_seq` when the page is empty. `has_more` is `cursor < latest_seq` ([L1196-L1199](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L1196-L1199)). `since_seq` past `latest_seq` raises `HostedRoomError` with the message `since_seq is ahead of the hosted room log` ([L1176-L1177](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L1176-L1177)). [`groups.log`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L488-L493) maps that to JSON-RPC error `4112`. The result model already has `cursor` and `has_more` ([`GroupsLogResult`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/groups_bot_relay.py#L260-L276)).
- `PROTOCOL_VERSION` is `2` ([`hosted_rooms.py` L23](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L23-L23)). `MAX_LOG_LIMIT` is `500`.
- There is no room push. The renderer polls every 2 seconds and re-reads the log from `since_seq: 0` (`apps/desktop/src/plugins/hermes-bots/canonical-group-workspace.tsx`, `refresh` / `poll`, both in this repo and the same file on upstream `4e59ac2b883b4133ea8a2d299abac45189781c09`).
- Global pushes already exist for sessions. [`_broadcast_watched_changes`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/change_watcher.py#L391-L414) calls [`_broadcast_global_event`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/server.py#L762-L778). `sessions.changed` is checked every 0.5 s and coalesced with `_CHANGE_BROADCAST_FLOOR_S` of 2.0 s ([L368-L384](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/change_watcher.py#L368-L384)): one signature and one floor per event name, and `payload_fn` takes no arguments. A burst keeps the old signature and fires once when the window opens, so the trailing change is not dropped. The signature includes `last_read_at` ([L193-L198](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/change_watcher.py#L193-L198)).
- `_broadcast_global_event` only writes to transports registered in **this process** (`_live_transports`). With no client, a dashboard process drops the frame (stdout is a log). It does not cross into the other Hermes process.
- The frame helper is [`_event_frame`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/server.py#L717-L720) in `tui_gateway/server.py`. It produces a JSON-RPC **notification** (`method` is `event`, no `id`):

  ```json
  {"jsonrpc":"2.0","method":"event","params":{"type":"<event>","session_id":"","payload":{}}}
  ```

  `sessions.changed` is `type: "sessions.changed"` with an empty payload. `groups.event` uses that same envelope. The plan's `{room_id, latest_seq, kind, epoch}` is the **payload**, not a new JSON-RPC method name.
- [`_stamp_event`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/event_replay.py#L67-L77) skips frames with an empty `session_id`. A global event is not in the replay ring. `session.events.since` will not replay `groups.event`. A missed hint is recovered by polling, which is what "hint only" means.

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
| `log` | `groups.log`, paged. Start `since_seq` at the last seq this client has applied for this room. Each response returns `cursor` and `has_more`. The next call sets `since_seq` to that `cursor`. Stop when `has_more` is false. One page is not the whole delta. |
| `state` | `groups.state`, then the same paged `groups.log` from that cursor |
| `read` | `groups.state` (for `read_seq` / `unread_count` once `read_cursors` exists). Do not assume the log grew. |

`kind: "state"` covers a room-row change (name, members, `authority_epoch`, disband). An implementer that only ever emits `log` and `read` is wrong: an authority change with no new message the user cares about still has to wake `groups.state`. Emitting `state` when a message also landed is allowed; the client then fetches both.

Unknown `room_id`: the client refetches `groups.list`, then applies the hint. A room created on Desktop is absent from the client's list until that refetch, which is what [#14](https://github.com/basilrari/hermes-mobile/issues/14) and [#26](https://github.com/basilrari/hermes-mobile/issues/26) need. There is no list-level event kind. The watcher still emits one hint for the new room. A client that drops an unknown `room_id` never learns the room exists.

## Contract registration

`groups.event` is registered in upstream `tui_gateway/contracts` as an **event**, with a pydantic payload. It is not a JSON-RPC method.

- Call [`registry.event`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L81-L84) `("groups.event", GroupsEventPayload)` so the name lands in `EVENTS`. `GroupsEventPayload` is the pydantic model of `{room_id, latest_seq, kind, epoch}` above.
- [`_event_frame`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/server.py#L717-L720) calls [`check_payload`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L155-L168) before the frame is written. A payload that does not match the model fails that check.
- [`test_catalog_covers_the_whole_wire`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tests/tui_gateway/contracts/test_generated.py#L90-L96) calls [`assert_complete`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/contracts/registry.py#L171-L182) on `server._methods`, `emitted_event_names()`, and `sent_server_requests()`. An emitted name with no event contract fails. An event contract that nothing emits fails as an orphan.
- The emit must be a string literal `_broadcast_global_event("groups.event", payload)`. `emitted_event_names()` only sees literals passed to `_broadcast_global_event` (and the other helpers it scans), plus the keys of `_CHANGE_WATCHES`. Putting the name only in the contract file leaves an orphan.

Do not add `groups.event` to [`_METHODS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L18-L23). That tuple is the method list `groups.capabilities` returns. `assert_complete` compares `server._methods` with contract `METHODS`, and emitted names with `EVENTS`. `groups.event` is not a method, so it is in neither method table. `groups.read` is the method that joins `_METHODS`; see `read-cursors.md`.

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
- Coalesce per room in a **dedicated dashboard watcher**. [`_broadcast_watched_changes`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/change_watcher.py#L391-L414) keeps one signature and one floor per event name, and `payload_fn()` takes no arguments, so one pass can emit `groups.event` at most once for the whole process and only with a payload that does not depend on which room moved. A hint has to carry that room's `room_id` and `latest_seq`. The dedicated watcher keeps its own map keyed by `room_id`: at most one `groups.event` per room per 2 seconds, trailing edge included, newest `latest_seq` of that room's burst. It still emits through `_broadcast_global_event("groups.event", payload)` so the existing fan-out and the contract scan stay in place. The session watcher is left alone.

## Restart and epoch

Two epochs already exist. They are not interchangeable.

| Token | Where | Survives process restart? |
|---|---|---|
| `authority_epoch` | `hosted_rooms.authority_epoch` (`claim_authority` does `authority_epoch+1`; `read_events` returns it as `authority.epoch`) | Yes. Starts at 1. Increases only on a fenced takeover. |
| `replay_epoch` | [`event_replay.replay_epoch`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/event_replay.py#L48-L50) (`uuid.uuid4().hex` at import). Returned by [`session.events.since`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_session.py#L2327-L2341) and `gateway.ready`. | No. New value every process start. Session seq counters reset with it. |

`groups.event.payload.epoch` is **`authority_epoch`**.

`claim_authority` also advances `next_seq`. Room seq does not rewind on restart or on takeover. A client **does not** zero its room cursor when `authority_epoch` changes, and it **does not** zero it when `gateway.ready.replay_epoch` changes. Session cursors still reset when `replay_epoch` changes; that rule is only for `session.events.since`.

The plan text "reset on epoch change" (HM-20) does not hold for the room log. Resetting on `replay_epoch` would re-download a durable log after every dashboard restart. Resetting on `authority_epoch` is unnecessary because seq does not rewind. The only full refetch is the `since_seq is ahead` error above.

## Dashboard and the messaging gateway

Both processes start a room driver on the same file:

- `hermes dashboard`: [`web_server_app.py`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_app.py#L90-L104) starts `tui_gateway/methods_groups.py:start_hosted_room_service`.
- `hermes gateway`: [`run_startup.py:_start_hosted_room_worker_sync`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/run_startup.py#L817-L829) starts the same service.

The database is [`default_db_path`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L404-L419): the root `shared-state.db` (a profile home under `profiles/` resolves to the install root, not that profile's `state.db`). The module docstring that says the root `state.db` is stale; `default_db_path` is the code.

[`local_authority_gateway_id()`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L422-L428) is the install id, so both processes share one gateway id. The driver lease ([`acquire_lease`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L532-L567)) is per room and is held by an in-memory `process_generation` ([`HostedRoomRuntime`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/hosted_room_driver.py#L143-L143), `uuid` hex). A second live generation gets `LeaseHeldError` until the lease expires or is released. That fences **task execution**. It does not deliver WebSocket events.

`groups.event` has to be produced by the **dashboard** process, the one that holds the app's WebSocket. It watches `shared-state.db` the way `_sessions_sig` watches `state.db` (read-only, content signature, not the WAL mtime alone). The messaging gateway may append the event; its own `_broadcast_global_event` does not reach the app. The watcher must run even when this process does not hold the lease.
