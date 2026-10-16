#!/usr/bin/env python3
"""Read-only checks for the Hermes install on this machine.

Grounded in NousResearch/hermes-agent
4e59ac2b883b4133ea8a2d299abac45189781c09. That commit is not in the
hermes-mobile checkout; the line numbers were read from the remote.

The dashboard password is read from HERMES_DASHBOARD_PASSWORD and is never
printed. SQLite is opened with mode=ro, the same shape as
hermes_state_holders.read_only_db_uri:
https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_state_holders.py#L27-L30
Nothing here writes a database, a config file, or a lease.

Exit status is 1 when any check is fail, and 0 when every check is pass or warn.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://pavillion-claw.tailfc1337.ts.net"
EXPECTED_BOTS = 3  # plan: Basil has 3 bots
BOT_CHAT_TITLE = "Bot Chat"
STOCK_FEATURES = frozenset({
    "authority_epoch", "coordinator_fencing", "room_identity", "monotonic_log",
    "idempotent_send", "replayable_disband", "typed_events", "actor_identity",
    "log_replication", "authority_takeover",
})
PLANNED_FEATURES = frozenset({"event_push", "read_cursors", "device_cursors"})
PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
IDENTITY_MARKERS = ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NOT_A_RUNNING_GATEWAY = frozenset({
    "status", "setup", "install", "start", "stop", "restart", "uninstall",
})


class Check:
    def __init__(self, name: str, status: str, detail: str) -> None:
        if status not in ("pass", "warn", "fail"):
            raise ValueError(status)
        self.name, self.status, self.detail = name, status, detail


class RpcError(Exception):
    """A gateway call failed. The message must already be free of secrets."""


def redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


def exit_code(checks: list[Check]) -> int:
    return 1 if any(check.status == "fail" for check in checks) else 0


def render(checks: list[Check], secrets: list[str]) -> str:
    rows = [("check", "status", "detail")] + [(c.name, c.status, c.detail) for c in checks]
    name_w = max(len(row[0]) for row in rows)
    status_w = max(len(row[1]) for row in rows)
    lines = []
    for index, (name, status, detail) in enumerate(rows):
        lines.append(f"{name:<{name_w}}  {status:<{status_w}}  {detail}")
        if index == 0:
            lines.append(f"{'-' * name_w}  {'-' * status_w}  -----")
    return redact("\n".join(lines) + "\n", secrets)


def open_ro(path: Path) -> sqlite3.Connection:
    """Open path read-only. A missing file raises; this does not create one."""
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=0.25)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def shared_state_path(home: Path) -> Path:
    """Root shared-state.db. Mirrors default_db_path.

    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L404-L419
    """
    if home.parent.name == "profiles":
        return home.parent.parent / "shared-state.db"
    return home / "shared-state.db"


def classify_argv(argv: list[str]) -> str | None:
    """`hermes dashboard` or a long-running `gateway` / `gateway run`.

    `hermes gateway status` (and setup/install/start/stop) is not the service.
    The service process is `hermes gateway run` (ExecStart) or a foreground
    `hermes gateway` with no further subcommand. `--replace` is still `run`.

    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/gateway.py#L3257-L3271
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/gateway.py#L4401-L4404
    """
    if "--stop" in argv:
        return None
    if "dashboard" in argv:
        return "dashboard"
    if "gateway" not in argv:
        return None
    rest = [token for token in argv[argv.index("gateway") + 1:] if not token.startswith("-")]
    if not rest or rest[0] == "run":
        return "gateway"
    if rest[0] in NOT_A_RUNNING_GATEWAY:
        return None
    return None


def list_processes(proc_root: Path) -> list[tuple[str, int]]:
    if not proc_root.is_dir():
        raise FileNotFoundError(str(proc_root))
    found = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        argv = [part for part in raw.decode("utf-8", "replace").split("\0") if part]
        role = classify_argv(argv)
        if role:
            found.append((role, int(entry.name)))
    return sorted(found, key=lambda item: (item[0], item[1]))


def pids_holding_db(proc_root: Path, db_path: Path, pids: list[int]) -> list[int] | None:
    """Pids among `pids` with the db (or its -wal/-shm) open. None if fds are unreadable."""
    target = str(db_path.resolve())
    holders: list[int] = []
    saw_fd_dir = False
    for pid in pids:
        fd_dir = proc_root / str(pid) / "fd"
        if not fd_dir.is_dir():
            continue
        saw_fd_dir = True
        for fd in fd_dir.iterdir():
            try:
                pointed = os.readlink(fd)
            except OSError:
                continue
            if pointed == target or pointed.startswith(target + "-"):
                holders.append(pid)
                break
    if not saw_fd_dir:
        return None
    return holders


def live_profiles(home: Path) -> list[Path]:
    """Named profiles, same identity rules as hermes_constants.named_profile_is_live.

    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_constants.py#L400-L405
    """
    root = home / "profiles"
    if not root.is_dir():
        return []
    found = []
    for child in sorted(root.iterdir(), key=lambda path: path.name):
        if not child.is_dir() or child.name.startswith(".") or not PROFILE_ID.fullmatch(child.name):
            continue
        if (root / ".deleted" / child.name).exists():
            continue
        if _has_identity(child):
            found.append(child)
    return found


def _has_identity(profile: Path) -> bool:
    for marker in IDENTITY_MARKERS:
        path = profile / marker
        try:
            if not path.is_file() and not path.is_symlink():
                continue
            if marker == ".env" and path.stat().st_size == 0:
                continue
            return True
        except OSError:
            continue
    return False


def has_hermes_bots(text: str) -> bool:
    """True when a profile.yaml has the ui_meta.hermes-bots marker (bot-mode.md)."""
    in_ui = False
    ui_indent = 0
    for raw in text.splitlines():
        stripped = raw.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(stripped)
        key, _, rest = stripped.partition(":")
        key = key.strip().strip("\"'")
        if key == "ui_meta":
            in_ui = True
            ui_indent = indent
            if "hermes-bots" in rest:
                return True
            continue
        if in_ui and indent <= ui_indent:
            in_ui = False
        if in_ui and key == "hermes-bots" and indent > ui_indent:
            return True
    return False


def basic_auth_username(text: str) -> str | None:
    """dashboard.basic_auth.username from config.yaml. Does not return the password."""
    in_dashboard = False
    in_basic = False
    dash_indent = basic_indent = 0
    for raw in text.splitlines():
        stripped = raw.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(stripped)
        key, _, rest = stripped.partition(":")
        key = key.strip().strip("\"'")
        if key == "dashboard" and indent == 0:
            in_dashboard = True
            dash_indent = indent
            in_basic = False
            continue
        if in_dashboard and indent <= dash_indent:
            in_dashboard = False
            in_basic = False
        if in_dashboard and key == "basic_auth" and indent > dash_indent:
            in_basic = True
            basic_indent = indent
            continue
        if in_basic and indent <= basic_indent:
            in_basic = False
        if in_basic and key == "username" and indent > basic_indent:
            value = rest.strip().strip("\"'")
            return value or None
    return None


def _table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return {row[0] for row in rows}


def check_bot_chats(home: Path) -> Check:
    """Each live named profile under profiles/ must have a Bot Chat session.

    The root install's state.db (~/.hermes/state.db) is not scanned.
    named_profile_is_live only treats a directory under profiles/ as a named
    profile, and a Bot Chat is created inside that profile. This check assumes
    the root profile does not need its own Bot Chat.
    """
    profiles = live_profiles(home)
    if not profiles:
        return Check("bot_chats", "fail", "no live profiles under profiles/")
    missing = []
    unreadable = []
    for profile in profiles:
        db_path = profile / "state.db"
        if not db_path.is_file():
            missing.append(profile.name)
            continue
        try:
            conn = open_ro(db_path)
        except sqlite3.Error:
            unreadable.append(profile.name)
            continue
        try:
            if "sessions" not in _table_names(conn):
                unreadable.append(profile.name)
                continue
            row = conn.execute(
                "SELECT 1 FROM sessions WHERE title = ? LIMIT 1", (BOT_CHAT_TITLE,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            missing.append(profile.name)
    detail = f"{len(profiles)} profile(s)"
    if len(profiles) != EXPECTED_BOTS:
        detail += f"; expected {EXPECTED_BOTS}"
    if missing:
        detail += "; no Bot Chat in " + ", ".join(missing)
    if unreadable:
        detail += "; unreadable state.db in " + ", ".join(unreadable)
    if missing or unreadable:
        return Check("bot_chats", "fail", detail)
    if len(profiles) != EXPECTED_BOTS:
        return Check("bot_chats", "warn", detail)
    return Check("bot_chats", "pass", detail + "; each has a Bot Chat session")


def check_ui_meta(home: Path) -> Check:
    paths = [home / "profile.yaml"] + [profile / "profile.yaml" for profile in live_profiles(home)]
    found = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if has_hermes_bots(text):
            found.append(str(path.relative_to(home)))
    if found:
        return Check("ui_meta", "pass", "hermes-bots marker in " + ", ".join(found))
    return Check("ui_meta", "fail", "no profile.yaml has ui_meta.hermes-bots")


def check_processes(proc_root: Path) -> tuple[Check, list[tuple[str, int]]]:
    try:
        found = list_processes(proc_root)
    except FileNotFoundError:
        return Check("processes", "fail", "process table not found"), []
    roles = {role for role, _pid in found}
    detail_parts = [f"{role} pid {pid}" for role, pid in found] or ["none"]
    missing = [role for role in ("dashboard", "gateway") if role not in roles]
    extras = []
    for role in ("dashboard", "gateway"):
        count = sum(1 for found_role, _pid in found if found_role == role)
        if count > 1:
            extras.append(f"{count} {role} processes")
    detail = "; ".join(detail_parts + extras)
    if missing:
        return Check("processes", "fail", detail + "; missing " + " and ".join(missing)), found
    if extras:
        return Check("processes", "warn", detail), found
    return Check("processes", "pass", detail), found


def _open_db_note(proc_root: Path, db_path: Path, processes: list[tuple[str, int]]) -> str:
    """Who has the file open. This is not evidence of a lease."""
    pids = [pid for _role, pid in processes]
    holders = pids_holding_db(proc_root, db_path, pids)
    if holders is None:
        return "processes with the DB open: unreadable"
    if not holders:
        return "processes with the DB open: none"
    named = ", ".join(f"{role} pid {pid}" for role, pid in processes if pid in holders)
    return "processes with the DB open: " + named


def check_driver_lease(home: Path, proc_root: Path, processes: list[tuple[str, int]], now: float) -> Check:
    """One lease row per room. Open file descriptors are not a lease.

    acquire_lease is keyed by room_id:
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L244-L249
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L532-L567

    Two live process_generation values on different rooms are a warning.
    Fail only when a live lease's authority_epoch disagrees with that room's
    hosted_rooms.authority_epoch, or the lease names a room_id that is not in
    hosted_rooms. A disbanded room that is still in the table is known.
    """
    db_path = shared_state_path(home)
    if not db_path.is_file():
        return Check("driver_lease", "warn", "shared-state.db is absent; no hosted rooms")
    try:
        conn = open_ro(db_path)
    except sqlite3.Error as exc:
        return Check("driver_lease", "fail", f"could not open shared-state.db read-only ({type(exc).__name__})")
    try:
        tables = _table_names(conn)
        if "hosted_rooms" not in tables:
            return Check("driver_lease", "warn", "shared-state.db has no hosted_rooms table")
        rooms = conn.execute(
            "SELECT room_id, authority_epoch, disbanded_at FROM hosted_rooms"
        ).fetchall()
        leases = []
        if "hosted_room_driver_leases" in tables:
            leases = conn.execute(
                "SELECT room_id, process_generation, authority_epoch, expires_at, released_at "
                "FROM hosted_room_driver_leases"
            ).fetchall()
    finally:
        conn.close()
    note = _open_db_note(proc_root, db_path, processes)
    known = {row["room_id"]: int(row["authority_epoch"]) for row in rooms}
    active = [row for row in rooms if row["disbanded_at"] is None]
    live = [
        row for row in leases
        if row["released_at"] is None and row["expires_at"] is not None and float(row["expires_at"]) > now
    ]
    unknown = []
    mismatched = []
    for row in live:
        room_id = row["room_id"]
        if room_id not in known:
            unknown.append(str(room_id))
            continue
        if int(row["authority_epoch"]) != known[room_id]:
            mismatched.append(
                f"{room_id} lease {int(row['authority_epoch'])} != room {known[room_id]}"
            )
    generations = sorted({str(row["process_generation"]) for row in live if row["process_generation"]})
    live_rooms = {row["room_id"] for row in live}
    epochs = sorted({int(row["authority_epoch"]) for row in live}) or sorted(
        int(row["authority_epoch"]) for row in active
    )
    epoch_text = ",".join(str(epoch) for epoch in epochs) if epochs else "none"
    if unknown or mismatched:
        parts = []
        if unknown:
            parts.append("lease for unknown room " + ",".join(unknown))
        if mismatched:
            parts.append("epoch mismatch " + "; ".join(mismatched))
        detail = "; ".join(parts)
        if generations:
            detail += "; process_generation=" + ",".join(item[:8] for item in generations)
        return Check("driver_lease", "fail", detail + "; " + note)
    if not generations:
        if active:
            return Check(
                "driver_lease", "warn",
                f"{len(active)} room(s), no unexpired lease; authority_epoch={epoch_text}; {note}",
            )
        return Check("driver_lease", "warn", "no rooms and no live driver lease; " + note)
    short = ",".join(item[:8] for item in generations)
    if len(generations) > 1:
        where = " on different rooms" if len(live_rooms) > 1 else ""
        return Check(
            "driver_lease", "warn",
            f"{len(generations)} live process_generation values{where} ({short}); "
            f"authority_epoch={epoch_text}; {note}",
        )
    return Check(
        "driver_lease", "pass",
        f"process_generation={short} authority_epoch={epoch_text}; {note}",
    )


def check_capabilities(result: dict | Exception | None) -> Check:
    if result is None:
        return Check("groups_capabilities", "fail", "not attempted")
    if isinstance(result, RpcError):
        return Check("groups_capabilities", "fail", str(result)[:200])
    if isinstance(result, Exception):
        return Check("groups_capabilities", "fail", type(result).__name__)
    if result.get("driver") is not True:
        return Check("groups_capabilities", "fail", "driver is not true")
    if "protocol_version" not in result:
        return Check("groups_capabilities", "fail", "protocol_version missing")
    features = result.get("features")
    if not isinstance(features, list) or any(not isinstance(item, str) for item in features):
        return Check("groups_capabilities", "fail", "features is not a list of strings")
    present = set(features)
    detail = f"protocol_version={result['protocol_version']} features={','.join(features)}"
    missing = sorted(STOCK_FEATURES - present)
    if missing:
        return Check("groups_capabilities", "warn", detail + "; missing " + ",".join(missing))
    if PLANNED_FEATURES - present:
        return Check("groups_capabilities", "pass", detail + "; stock gateway")
    return Check("groups_capabilities", "pass", detail)


def check_scheme(url: str) -> Check:
    parts = urllib.parse.urlsplit(url)
    if parts.username or parts.password:
        return Check("https_url", "fail", "URL must not contain credentials")
    if parts.scheme != "https":
        return Check("https_url", "fail", f"scheme is {parts.scheme or 'empty'}")
    return Check("https_url", "pass", url)


def check_https_answer(response: object) -> Check:
    if response is None:
        return Check("https_answer", "fail", "not attempted")
    if isinstance(response, Exception):
        return Check("https_answer", "fail", "HTTPS request failed")
    status, _body = response
    if status >= 500:
        return Check("https_answer", "fail", f"HTTP {status}")
    return Check("https_answer", "pass", f"HTTP {status}")


def check_api_status(response: object) -> Check:
    if response is None or isinstance(response, Exception):
        return Check("api_status", "fail", "no response")
    status, body = response
    if status != 200:
        return Check("api_status", "fail", f"HTTP {status}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return Check("api_status", "fail", "status body was not JSON")
    if not isinstance(data, dict) or "version" not in data:
        return Check("api_status", "fail", "body was not a status object")
    detail = f"version={data.get('version')} gateway_running={data.get('gateway_running')}"
    if data.get("gateway_running") is False:
        return Check("api_status", "warn", detail)
    return Check("api_status", "pass", detail)


def resolve_username(home: Path, env: dict[str, str]) -> str | None:
    username = env.get("HERMES_DASHBOARD_USERNAME", "").strip()
    if username:
        return username
    path = home / "config.yaml"
    if not path.is_file():
        return None
    try:
        return basic_auth_username(path.read_text(encoding="utf-8"))
    except OSError:
        return None


def run(
    home: Path,
    url: str,
    password: str,
    username: str | None,
    *,
    http_get,
    fetch_caps,
    proc_root: Path,
    now: float,
) -> list[Check]:
    checks = [check_scheme(url)]
    response: object = None
    if checks[0].status == "pass":
        try:
            response = http_get(url.rstrip("/") + "/api/status")
        except Exception as exc:
            response = exc
    checks.append(check_https_answer(response))
    checks.append(check_api_status(response))
    if checks[0].status != "pass":
        caps: object = RpcError("refused non-https URL")
    elif not password:
        caps = RpcError("HERMES_DASHBOARD_PASSWORD is not set")
    elif not username:
        caps = RpcError("dashboard username not found")
    else:
        try:
            caps = fetch_caps(url, username, password)
        except Exception as exc:
            caps = exc
    checks.append(check_capabilities(caps if isinstance(caps, (dict, Exception)) else None))
    checks.append(check_bot_chats(home))
    checks.append(check_ui_meta(home))
    process_check, processes = check_processes(proc_root)
    checks.append(process_check)
    checks.append(check_driver_lease(home, proc_root, processes, now))
    return checks


def http_get(url: str, timeout: float = 10) -> tuple[int, bytes]:
    if urllib.parse.urlsplit(url).scheme != "https":
        raise RpcError("refusing non-https URL")
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read(1_000_000)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """auth_logout answers 302. Leave that status for the caller."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _logout(opener, origin: str, timeout: float) -> None:
    """POST /auth/logout and discard the response.

    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/dashboard_auth/routes.py#L496-L510
    answers 302. A failed logout leaves the server session until its TTL.
    The body, the ticket, and the URL are not returned.
    """
    request = urllib.request.Request(
        origin + "/auth/logout",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            response.read()
    except urllib.error.HTTPError:
        return
    except urllib.error.URLError:
        return
    except OSError:
        return


def fetch_capabilities(base_url: str, username: str, password: str, timeout: float = 15) -> dict:
    """POST /auth/password-login, POST /api/auth/ws-ticket, groups.capabilities, then logout.

    Provider name "basic":
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/plugins/dashboard_auth/basic/__init__.py#L114-L119
    Login route:
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/dashboard_auth/routes.py#L447-L455
    The ticket is query param `ticket` on /api/ws:
    https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_chat.py#L200-L216

    Logout runs after the RPC, success or failure. A logout error does not
    change this function's result and is not printed. If logout fails, the
    server session stays open until its TTL.
    """
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme != "https" or parts.username or parts.password:
        raise RpcError("refusing non-https URL")
    origin = f"{parts.scheme}://{parts.netloc}"
    jar = urllib.request.HTTPCookieProcessor()
    opener = urllib.request.build_opener(jar, _NoRedirect())
    _post_ok(opener, origin + "/auth/password-login", {
        "provider": "basic", "username": username, "password": password,
    }, "password login", timeout)
    payload = _post_json(opener, origin + "/api/auth/ws-ticket", {}, "ws-ticket", timeout)
    ticket = payload.get("ticket") if isinstance(payload, dict) else None
    if not isinstance(ticket, str) or not ticket:
        raise RpcError("ws-ticket response had no ticket")
    try:
        return ws_rpc(origin, ticket, "groups.capabilities", {}, timeout)
    finally:
        try:
            _logout(opener, origin, timeout)
        except Exception:
            pass
        del ticket


def _post_ok(opener, url: str, body: dict, what: str, timeout: float) -> None:
    data = json.dumps(body).encode()
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with opener.open(request, timeout=timeout) as response:
            response.read()
            if response.status != 200:
                raise RpcError(f"{what} failed: HTTP {response.status}")
    except RpcError:
        raise
    except urllib.error.HTTPError as exc:
        raise RpcError(f"{what} failed: HTTP {exc.code}") from None
    except urllib.error.URLError:
        raise RpcError(f"{what} failed: network error") from None


def _post_json(opener, url: str, body: dict, what: str, timeout: float) -> dict:
    data = json.dumps(body).encode()
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(1_000_000)
            if response.status != 200:
                raise RpcError(f"{what} failed: HTTP {response.status}")
    except RpcError:
        raise
    except urllib.error.HTTPError as exc:
        raise RpcError(f"{what} failed: HTTP {exc.code}") from None
    except urllib.error.URLError:
        raise RpcError(f"{what} failed: network error") from None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise RpcError(f"{what} response was not JSON") from None
    if not isinstance(parsed, dict):
        raise RpcError(f"{what} response was not an object")
    return parsed


def ws_rpc(origin: str, ticket: str, method: str, params: dict, timeout: float) -> dict:
    import base64
    import hashlib
    import socket
    import time

    parts = urllib.parse.urlsplit(origin)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path = "/api/ws?ticket=" + urllib.parse.quote(ticket, safe="")
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        if parts.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = parts.netloc
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode())
        pending = bytearray()
        while b"\r\n\r\n" not in pending:
            chunk = sock.recv(4096)
            if not chunk:
                raise RpcError("websocket closed")
            pending += chunk
            if len(pending) > 8192 and b"\r\n\r\n" not in pending:
                raise RpcError("websocket header too large")
        split_at = pending.index(b"\r\n\r\n")
        header = bytes(pending[: split_at + 4])
        del pending[: split_at + 4]
        status_line = header.split(b"\r\n", 1)[0].decode("iso-8859-1", "replace")
        pieces = status_line.split(" ")
        code = pieces[1] if len(pieces) > 1 else "?"
        if code != "101":
            raise RpcError(f"websocket upgrade failed: HTTP {code}")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if accept.encode() not in header:
            raise RpcError("websocket upgrade rejected")
        _ws_send_text(sock, json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        }))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = _ws_recv_text(sock, deadline, pending)
            try:
                obj = json.loads(message)
            except json.JSONDecodeError:
                continue
            if obj.get("id") != 1:
                continue
            if "error" in obj and isinstance(obj["error"], dict):
                raise RpcError(f"groups.capabilities error code {obj['error'].get('code')}")
            result = obj.get("result")
            if not isinstance(result, dict):
                raise RpcError("groups.capabilities result was not an object")
            return result
        raise RpcError("groups.capabilities timed out")
    finally:
        sock.close()


def _ws_send_text(sock, text: str) -> None:
    data = text.encode()
    header = bytearray([0x81])
    length = len(data)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += length.to_bytes(2, "big")
    else:
        header.append(0x80 | 127)
        header += length.to_bytes(8, "big")
    mask = os.urandom(4)
    header += mask
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    sock.sendall(bytes(header) + masked)


def _ws_recv_exact(sock, count: int, deadline: float, pending: bytearray) -> bytes:
    import time
    while len(pending) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RpcError("groups.capabilities timed out")
        sock.settimeout(remaining)
        chunk = sock.recv(count - len(pending))
        if not chunk:
            raise RpcError("websocket closed")
        pending += chunk
    data = bytes(pending[:count])
    del pending[:count]
    return data


def _ws_recv_text(sock, deadline: float, pending: bytearray) -> str:
    while True:
        head = _ws_recv_exact(sock, 2, deadline, pending)
        opcode = head[0] & 0x0F
        length = head[1] & 0x7F
        if length == 126:
            length = int.from_bytes(_ws_recv_exact(sock, 2, deadline, pending), "big")
        elif length == 127:
            length = int.from_bytes(_ws_recv_exact(sock, 8, deadline, pending), "big")
        mask = _ws_recv_exact(sock, 4, deadline, pending) if head[1] & 0x80 else None
        if length > 1_000_000:
            raise RpcError("websocket frame too large")
        data = _ws_recv_exact(sock, length, deadline, pending) if length else b""
        if mask:
            data = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        if opcode == 0x8:
            raise RpcError("websocket closed")
        if opcode == 0x9:
            _ws_send_control(sock, 0x8A, data)
            continue
        if opcode == 0x1:
            return data.decode("utf-8", "replace")
        continue


def _ws_send_control(sock, opcode: int, data: bytes) -> None:
    header = bytearray([0x80 | opcode])
    header.append(0x80 | len(data))
    mask = os.urandom(4)
    header += mask
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    sock.sendall(bytes(header) + masked)


def parse_args(argv: list[str], env: dict[str, str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only Hermes gateway doctor.")
    parser.add_argument("--home", default=env.get("HERMES_HOME", str(Path.home() / ".hermes")))
    parser.add_argument("--url", default=env.get("HERMES_DASHBOARD_URL", DEFAULT_URL))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, env: dict[str, str] | None = None, **overrides) -> int:
    import time
    env = os.environ if env is None else env
    args = parse_args(sys.argv[1:] if argv is None else argv, env)
    password = env.get("HERMES_DASHBOARD_PASSWORD", "")
    home = Path(args.home)
    username = resolve_username(home, env)
    # Only the password. A short username would punch holes in the table.
    secrets = [password]
    checks = run(
        home,
        args.url,
        password,
        username,
        http_get=overrides.get("http_get", http_get),
        fetch_caps=overrides.get("fetch_caps", fetch_capabilities),
        proc_root=overrides.get("proc_root", Path("/proc")),
        now=overrides.get("now", time.time()),
    )
    sys.stdout.write(render(checks, secrets))
    return exit_code(checks)


if __name__ == "__main__":
    sys.exit(main())
