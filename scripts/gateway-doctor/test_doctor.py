"""Fixture tests for the read-only gateway doctor. No network, no secrets on disk."""

from __future__ import annotations

import hashlib
import io
import json
import socket
import sqlite3
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import doctor

SECRET = "super-secret-rpc-password-9f3a"
TICKET = "ticket-value-not-a-password-77"
NOW = 1_700_000_000.0


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _argv_bytes(argv: list[str]) -> bytes:
    return b"\0".join(part.encode() for part in argv) + b"\0"


def _proc(root: Path, pid: int, argv: list[str], fds: dict[str, Path] | None = None) -> None:
    entry = root / str(pid)
    entry.mkdir()
    (entry / "cmdline").write_bytes(_argv_bytes(argv))
    if fds is None:
        return
    fd_dir = entry / "fd"
    fd_dir.mkdir()
    for name, target in fds.items():
        (fd_dir / name).symlink_to(target)


def _session_db(path: Path, title: str | None = "Bot Chat") -> None:
    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE sessions (id TEXT, title TEXT)")
    if title is not None:
        conn.execute("INSERT INTO sessions (id, title) VALUES ('s1', ?)", (title,))
    conn.commit()
    conn.close()


def _profile(home: Path, name: str, title: str | None = "Bot Chat") -> Path:
    profile = home / "profiles" / name
    profile.mkdir(parents=True)
    _session_db(profile / "state.db", title)
    return profile


def _shared(home: Path, leases: list[tuple], rooms: list[tuple] | None = None) -> Path:
    path = home / "shared-state.db"
    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE hosted_rooms ("
        "room_id TEXT, authority_gateway_id TEXT, authority_epoch INTEGER, disbanded_at REAL)"
    )
    conn.execute(
        "CREATE TABLE hosted_room_driver_leases ("
        "room_id TEXT, gateway_id TEXT, authority_epoch INTEGER, "
        "process_generation TEXT, expires_at REAL, released_at REAL)"
    )
    if rooms is None:
        rooms = [("room-1", "gw", 3, None)]
    conn.executemany("INSERT INTO hosted_rooms VALUES (?, ?, ?, ?)", rooms)
    conn.executemany(
        "INSERT INTO hosted_room_driver_leases VALUES (?, ?, ?, ?, ?, ?)", leases
    )
    conn.commit()
    conn.close()
    return path


def _statuses(text: str) -> dict[str, str]:
    rows = {}
    for line in text.splitlines():
        if not line or line.startswith("check") or set(line.strip()) <= set("- "):
            continue
        name, status, _detail = line.split(None, 2)
        rows[name] = status
    return rows


def _detail(text: str, name: str) -> str:
    for line in text.splitlines():
        if line.startswith(name + " "):
            return line.split(None, 2)[2]
    raise AssertionError(name)


class DoctorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = __import__("tempfile").TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.home = self.root / "hermes"
        self.home.mkdir()
        self.proc = self.root / "proc"
        self.proc.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _live_lease(self, generation: str = "abcdef1234567890") -> list[tuple]:
        return [("room-1", "gw", 3, generation, NOW + 60, None)]

    def _healthy_files(self, holders: list[int] | None = None) -> Path:
        for name in ("alpha", "beta", "gamma"):
            _profile(self.home, name)
        decoy = self.home / "profiles" / "emptyenv"
        decoy.mkdir()
        (decoy / ".env").write_bytes(b"")
        (self.home / "profiles" / "Bad Name").mkdir()
        tomb = self.home / "profiles" / "gone"
        _profile(self.home, "gone", title=None)
        (self.home / "profiles" / ".deleted").mkdir()
        (self.home / "profiles" / ".deleted" / "gone").write_text("x", encoding="utf-8")
        (self.home / "profiles" / "alpha" / "profile.yaml").write_text(
            "ui_meta:\n  hermes-bots: {}\n", encoding="utf-8"
        )
        db = _shared(self.home, self._live_lease())
        target = db.resolve()
        hold = set(holders if holders is not None else [20])
        _proc(self.proc, 11, ["hermes", "gateway", "status"])
        _proc(self.proc, 12, ["hermes", "dashboard", "--stop"])
        _proc(
            self.proc, 20,
            ["hermes", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", "9119"],
            {"3": target} if 20 in hold else {},
        )
        _proc(
            self.proc, 30, ["/usr/local/bin/hermes", "gateway", "run"],
            {"4": target} if 30 in hold else {},
        )
        return db

    def _run(self, *, url=None, password=SECRET, username="basil", http_get=None,
             fetch_caps=None, now=NOW, env_extra=None):
        argv = ["--home", str(self.home)]
        if url is not None:
            argv.extend(["--url", url])
        env = {
            "HERMES_DASHBOARD_PASSWORD": password,
            "HERMES_DASHBOARD_USERNAME": username,
        }
        if env_extra:
            env.update(env_extra)
        calls = {"http": 0, "caps": 0}

        def default_http(target):
            calls["http"] += 1
            body = json.dumps({
                "version": "1.2.3",
                "gateway_running": True,
                "echo": password,
            }).encode()
            return 200, body

        def default_caps(target, user, pw):
            calls["caps"] += 1
            calls["user"] = user
            calls["pw"] = pw
            return {
                "driver": True,
                "protocol_version": 2,
                "features": sorted(doctor.STOCK_FEATURES),
            }

        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            code = doctor.main(
                argv, env,
                http_get=http_get or default_http,
                fetch_caps=fetch_caps or default_caps,
                proc_root=self.proc,
                now=now,
            )
        return code, buf.getvalue(), calls

    def test_healthy_one_holder_exits_0_and_does_not_write(self) -> None:
        db = self._healthy_files()
        before = {path: _sha(path) for path in self.home.rglob("*") if path.is_file()}
        uris = []
        real = sqlite3.connect

        def wrapped(database, *args, **kwargs):
            uris.append((database, kwargs.get("uri")))
            return real(database, *args, **kwargs)

        with mock.patch.object(doctor.sqlite3, "connect", wrapped):
            code, text, calls = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(calls["http"], 1)
        self.assertEqual(calls["user"], "basil")
        statuses = _statuses(text)
        self.assertEqual(statuses, {
            "https_url": "pass",
            "https_answer": "pass",
            "api_status": "pass",
            "groups_capabilities": "pass",
            "bot_chats": "pass",
            "ui_meta": "pass",
            "processes": "pass",
            "driver_lease": "pass",
        })
        self.assertIn("stock gateway", text)
        self.assertIn("processes with the DB open: dashboard pid 20", text)
        self.assertNotIn("only dashboard", text)
        self.assertNotIn("pid 11", text)
        self.assertNotIn("pid 12", text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn("[redacted]", _detail(text, "api_status"))
        self.assertTrue(uris)
        self.assertTrue(all("mode=ro" in uri and flag is True for uri, flag in uris))
        after = {path: _sha(path) for path in self.home.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(_sha(db), before[db])

    def test_both_holders_are_informational_and_exit_0(self) -> None:
        self._healthy_files(holders=[20, 30])
        code, text, _calls = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["driver_lease"], "pass")
        detail = _detail(text, "driver_lease")
        self.assertIn("processes with the DB open: dashboard pid 20, gateway pid 30", detail)
        self.assertNotIn("lease does not store a pid", text)
        self.assertNotIn("only dashboard", text)
        self.assertNotIn(SECRET, text)

    def test_two_live_generations_on_different_rooms_warn(self) -> None:
        self._healthy_files()
        _shared(self.home, [
            ("room-1", "gw", 3, "aaaaaaaa-1111", NOW + 60, None),
            ("room-2", "gw", 4, "bbbbbbbb-2222", NOW + 60, None),
        ], rooms=[("room-1", "gw", 3, None), ("room-2", "gw", 4, None)])
        code, text, _calls = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["driver_lease"], "warn")
        detail = _detail(text, "driver_lease")
        self.assertIn("on different rooms", detail)
        self.assertIn("aaaaaaaa", detail)
        self.assertIn("bbbbbbbb", detail)

    def test_lease_epoch_mismatch_fails(self) -> None:
        self._healthy_files()
        _shared(self.home, [
            ("room-1", "gw", 9, "aaaaaaaa-1111", NOW + 60, None),
        ], rooms=[("room-1", "gw", 3, None)])
        code, text, _calls = self._run()
        self.assertEqual(code, 1)
        self.assertEqual(_statuses(text)["driver_lease"], "fail")
        self.assertIn("epoch mismatch room-1 lease 9 != room 3", _detail(text, "driver_lease"))

    def test_lease_for_unknown_room_fails(self) -> None:
        self._healthy_files()
        _shared(self.home, [
            ("room-missing", "gw", 3, "aaaaaaaa-1111", NOW + 60, None),
        ], rooms=[("room-1", "gw", 3, None)])
        code, text, _calls = self._run()
        self.assertEqual(code, 1)
        self.assertEqual(_statuses(text)["driver_lease"], "fail")
        self.assertIn("lease for unknown room room-missing", _detail(text, "driver_lease"))

    def test_disbanded_room_is_a_known_room(self) -> None:
        self._healthy_files()
        _shared(self.home, [
            ("room-1", "gw", 3, "abcdef1234567890", NOW + 60, None),
        ], rooms=[("room-1", "gw", 3, NOW - 10)])
        code, text, _calls = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["driver_lease"], "pass")
        self.assertNotIn("unknown room", text)

    def test_missing_bot_chat_fails(self) -> None:
        self._healthy_files()
        _session_db(self.home / "profiles" / "beta" / "state.db", title="scratch")
        code, text, _calls = self._run()
        self.assertEqual(code, 1)
        self.assertEqual(_statuses(text)["bot_chats"], "fail")
        self.assertIn("beta", _detail(text, "bot_chats"))

    def test_profile_count_warns_without_failing(self) -> None:
        self._healthy_files()
        _profile(self.home, "delta")
        code, text, _calls = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["bot_chats"], "warn")
        self.assertIn("expected 3", text)

    def test_no_marker_fails(self) -> None:
        self._healthy_files()
        (self.home / "profiles" / "alpha" / "profile.yaml").write_text(
            "# hermes-bots: {}\nname: alpha\n", encoding="utf-8"
        )
        code, text, _calls = self._run()
        self.assertEqual(code, 1)
        self.assertEqual(_statuses(text)["ui_meta"], "fail")

    def test_flow_style_marker_passes(self) -> None:
        self._healthy_files()
        (self.home / "profiles" / "alpha" / "profile.yaml").write_text(
            "ui_meta: { hermes-bots: {} }\n", encoding="utf-8"
        )
        code, text, _calls = self._run()
        self.assertEqual(_statuses(text)["ui_meta"], "pass")
        self.assertEqual(code, 0)

    def test_gateway_running_false_warns(self) -> None:
        self._healthy_files()

        def http_get(_url):
            return 200, json.dumps({"version": "1.2.3", "gateway_running": False}).encode()

        code, text, _calls = self._run(http_get=http_get)
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["api_status"], "warn")

    def test_non_json_status_does_not_echo_body(self) -> None:
        self._healthy_files()

        def http_get(_url):
            return 200, f"nope {SECRET}".encode()

        code, text, _calls = self._run(http_get=http_get)
        self.assertEqual(code, 1)
        self.assertEqual(_detail(text, "api_status"), "status body was not JSON")
        self.assertNotIn(SECRET, text)

    def test_http_url_does_not_connect(self) -> None:
        self._healthy_files()

        def boom(*_args, **_kwargs):
            raise AssertionError("network helper was called")

        code, text, _calls = self._run(url="http://127.0.0.1:9119", http_get=boom, fetch_caps=boom)
        self.assertEqual(code, 1)
        self.assertEqual(_statuses(text)["https_url"], "fail")
        self.assertEqual(_detail(text, "groups_capabilities"), "refused non-https URL")
        self.assertNotIn(SECRET, text)

    def test_url_userinfo_is_not_echoed(self) -> None:
        self._healthy_files()

        def boom(*_args, **_kwargs):
            raise AssertionError("network helper was called")

        code, text, _calls = self._run(
            url=f"https://basil:{SECRET}@pavillion-claw.tailfc1337.ts.net",
            http_get=boom, fetch_caps=boom,
        )
        self.assertEqual(code, 1)
        self.assertEqual(_detail(text, "https_url"), "URL must not contain credentials")
        self.assertNotIn(SECRET, text)
        self.assertNotIn("pavillion-claw", _detail(text, "https_url"))

    def test_rpc_error_password_is_redacted(self) -> None:
        self._healthy_files()

        def fetch_caps(_url, _user, _pw):
            raise doctor.RpcError(f"leaked {SECRET} ticket {TICKET}")

        code, text, _calls = self._run(fetch_caps=fetch_caps)
        self.assertEqual(code, 1)
        self.assertNotIn(SECRET, text)
        self.assertIn("[redacted]", _detail(text, "groups_capabilities"))

    def test_password_bearing_exception_is_redacted_for_every_check(self) -> None:
        self._healthy_files()
        checks = [
            doctor.check_scheme(f"https://user:{SECRET}@example.test"),
            doctor.check_https_answer(RuntimeError(SECRET)),
            doctor.check_api_status(RuntimeError(SECRET)),
            doctor.check_capabilities(doctor.RpcError(f"login failed {SECRET}")),
            doctor.check_capabilities(RuntimeError(SECRET)),
        ]

        def boom_db(*_args, **_kwargs):
            raise sqlite3.OperationalError(SECRET)

        with mock.patch.object(doctor, "open_ro", boom_db):
            checks.append(doctor.check_bot_chats(self.home))
            checks.append(doctor.check_driver_lease(
                self.home, self.proc, [("dashboard", 20)], NOW))

        def boom_read(*_args, **_kwargs):
            raise OSError(SECRET)

        with mock.patch.object(Path, "read_text", boom_read):
            checks.append(doctor.check_ui_meta(self.home))

        def boom_proc(_root):
            raise FileNotFoundError(SECRET)

        with mock.patch.object(doctor, "list_processes", boom_proc):
            checks.append(doctor.check_processes(self.proc)[0])

        self.assertEqual(
            {check.name for check in checks},
            {
                "https_url", "https_answer", "api_status", "groups_capabilities",
                "bot_chats", "ui_meta", "processes", "driver_lease",
            },
        )
        text = doctor.render(checks, [SECRET])
        self.assertNotIn(SECRET, text)
        self.assertIn("[redacted]", text)
        self.assertEqual(_detail(text, "https_answer"), "HTTPS request failed")
        self.assertEqual(_detail(text, "api_status"), "no response")
        self.assertIn("[redacted]", _detail(text, "groups_capabilities"))
        self.assertNotIn(SECRET, _detail(text, "bot_chats"))
        self.assertNotIn(SECRET, _detail(text, "driver_lease"))
        self.assertNotIn(SECRET, _detail(text, "ui_meta"))
        self.assertNotIn(SECRET, _detail(text, "processes"))

    def test_generic_exception_hides_message(self) -> None:
        self._healthy_files()

        def fetch_caps(_url, _user, _pw):
            raise RuntimeError(SECRET)

        _code, text, _calls = self._run(fetch_caps=fetch_caps)
        self.assertEqual(_detail(text, "groups_capabilities"), "RuntimeError")
        self.assertNotIn(SECRET, text)
        self.assertNotIn("Traceback", text)

    def test_username_comes_from_config_not_password_field(self) -> None:
        self._healthy_files()
        (self.home / "config.yaml").write_text(
            "dashboard:\n"
            "  basic_auth:\n"
            f"    username: basil\n"
            f"    password: {SECRET}\n",
            encoding="utf-8",
        )

        seen = {}

        def fetch_caps(_url, user, _pw):
            seen["user"] = user
            return {
                "driver": True,
                "protocol_version": 2,
                "features": sorted(doctor.STOCK_FEATURES),
            }

        code, text, _calls = self._run(username="", fetch_caps=fetch_caps)
        self.assertEqual(seen["user"], "basil")
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, text)

    def test_driver_false_fails(self) -> None:
        self._healthy_files()

        def fetch_caps(*_args):
            return {"driver": False, "protocol_version": 2, "features": sorted(doctor.STOCK_FEATURES)}

        code, text, _calls = self._run(fetch_caps=fetch_caps)
        self.assertEqual(code, 1)
        self.assertEqual(_detail(text, "groups_capabilities"), "driver is not true")

    def test_missing_shared_state_is_not_created(self) -> None:
        for name in ("alpha", "beta", "gamma"):
            _profile(self.home, name)
        (self.home / "profiles" / "alpha" / "profile.yaml").write_text(
            "ui_meta: { hermes-bots: {} }\n", encoding="utf-8"
        )
        _proc(self.proc, 20, ["hermes", "dashboard", "--no-open"], {})
        _proc(self.proc, 30, ["hermes", "gateway", "run"], {})
        missing = self.home / "shared-state.db"
        code, text, _calls = self._run()
        self.assertFalse(missing.exists())
        self.assertEqual(code, 0)
        self.assertEqual(_statuses(text)["driver_lease"], "warn")

    def test_open_ro_rejects_writes_and_missing_files(self) -> None:
        missing = self.home / "absent.db"
        with self.assertRaises(sqlite3.OperationalError):
            doctor.open_ro(missing)
        self.assertFalse(missing.exists())
        path = self.home / "state.db"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE t (id INTEGER)")
        conn.commit()
        conn.close()
        before = path.read_bytes()
        ro = doctor.open_ro(path)
        try:
            with self.assertRaises(sqlite3.OperationalError) as caught:
                ro.execute("CREATE TABLE other (id INTEGER)")
        finally:
            ro.close()
        self.assertIn("readonly", str(caught.exception).lower())
        self.assertEqual(path.read_bytes(), before)

    def test_classify_argv(self) -> None:
        self.assertEqual(doctor.classify_argv(["hermes", "dashboard", "--no-open"]), "dashboard")
        self.assertIsNone(doctor.classify_argv(["hermes", "dashboard", "--stop"]))
        self.assertEqual(doctor.classify_argv(["hermes", "gateway", "run"]), "gateway")
        self.assertEqual(doctor.classify_argv(["hermes", "gateway"]), "gateway")
        self.assertIsNone(doctor.classify_argv(["hermes", "gateway", "status"]))
        self.assertIsNone(doctor.classify_argv(["hermes", "gateway", "install"]))
        self.assertIsNone(doctor.classify_argv(["hermes", "gateway", "start"]))

    def test_yaml_scanners(self) -> None:
        self.assertTrue(doctor.has_hermes_bots("ui_meta: { hermes-bots: {} }\n"))
        self.assertTrue(doctor.has_hermes_bots("ui_meta:\n  hermes-bots: {}\n"))
        self.assertFalse(doctor.has_hermes_bots("# ui_meta:\n#   hermes-bots: {}\n"))
        self.assertFalse(doctor.has_hermes_bots("hermes-bots: {}\n"))
        text = f"dashboard:\n  basic_auth:\n    username: basil\n    password: {SECRET}\n"
        self.assertEqual(doctor.basic_auth_username(text), "basil")

    def test_exit_code_helper(self) -> None:
        self.assertEqual(doctor.exit_code([doctor.Check("a", "pass", "")]), 0)
        self.assertEqual(doctor.exit_code([doctor.Check("a", "warn", "")]), 0)
        self.assertEqual(doctor.exit_code([
            doctor.Check("a", "pass", ""), doctor.Check("b", "fail", ""),
        ]), 1)

    def test_fetch_capabilities_refuses_before_connect(self) -> None:
        with self.assertRaises(doctor.RpcError) as http_err:
            doctor.fetch_capabilities("http://127.0.0.1:9", "basil", SECRET, timeout=0.2)
        self.assertEqual(str(http_err.exception), "refusing non-https URL")
        with self.assertRaises(doctor.RpcError) as info_err:
            doctor.fetch_capabilities(
                f"https://basil:{SECRET}@127.0.0.1:9", "basil", "other", timeout=0.2
            )
        self.assertEqual(str(info_err.exception), "refusing non-https URL")
        self.assertNotIn(SECRET, str(info_err.exception))

    def test_post_ok_hides_401_body(self) -> None:
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                seen["body"] = self.rfile.read(length)
                payload = f"{SECRET} {TICKET}".encode()
                self.send_response(401)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _fmt, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = __import__("urllib.request").request.build_opener()
            url = f"http://127.0.0.1:{server.server_address[1]}/auth/password-login"
            with self.assertRaises(doctor.RpcError) as caught:
                doctor._post_ok(opener, url, {"password": SECRET}, "password login", 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertEqual(str(caught.exception), "password login failed: HTTP 401")
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn(TICKET, str(caught.exception))
        self.assertIn(SECRET.encode(), seen["body"])

    def test_logout_discards_302_body(self) -> None:
        seen = {"paths": []}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                seen["paths"].append(self.path)
                body = f"bye {SECRET} {TICKET}".encode()
                self.send_response(302)
                self.send_header("Location", "/login")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _fmt, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = __import__("urllib.request").request.build_opener(doctor._NoRedirect())
            origin = f"http://127.0.0.1:{server.server_address[1]}"
            doctor._logout(opener, origin, 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertEqual(seen["paths"], ["/auth/logout"])

    def test_fetch_capabilities_logs_out_and_logout_failure_is_quiet(self) -> None:
        calls = []

        def logout(_opener, origin, _timeout):
            calls.append(origin)
            raise RuntimeError(SECRET)

        with mock.patch.object(doctor, "_post_ok"), \
                mock.patch.object(doctor, "_post_json", return_value={"ticket": TICKET}), \
                mock.patch.object(doctor, "ws_rpc", return_value={"driver": True}), \
                mock.patch.object(doctor, "_logout", logout):
            result = doctor.fetch_capabilities("https://example.test", "basil", SECRET, timeout=1)
        self.assertEqual(result, {"driver": True})
        self.assertEqual(calls, ["https://example.test"])

        def fail_rpc(*_args, **_kwargs):
            raise doctor.RpcError("groups.capabilities error code -32601")

        with mock.patch.object(doctor, "_post_ok"), \
                mock.patch.object(doctor, "_post_json", return_value={"ticket": TICKET}), \
                mock.patch.object(doctor, "ws_rpc", fail_rpc), \
                mock.patch.object(doctor, "_logout", logout):
            with self.assertRaises(doctor.RpcError) as caught:
                doctor.fetch_capabilities("https://example.test", "basil", SECRET, timeout=1)
        self.assertEqual(str(caught.exception), "groups.capabilities error code -32601")
        self.assertNotIn(SECRET, str(caught.exception))

    def test_ws_rpc_skips_non_text_and_hides_ticket(self) -> None:
        features = sorted(doctor.STOCK_FEATURES)
        result = {"driver": True, "protocol_version": 2, "features": features}

        def send_text(conn: socket.socket, text: str) -> None:
            data = text.encode()
            if len(data) < 126:
                header = bytes([0x81, len(data)])
            else:
                header = bytes([0x81, 126]) + len(data).to_bytes(2, "big")
            conn.sendall(header + data)

        def handler(conn: socket.socket) -> None:
            data = b""
            while b"\r\n\r\n" not in data:
                data += conn.recv(4096)
            key = b""
            for line in data.split(b"\r\n"):
                if line.lower().startswith(b"sec-websocket-key:"):
                    key = line.split(b":", 1)[1].strip()
            accept = __import__("base64").b64encode(
                hashlib.sha1(key + doctor.WS_GUID.encode()).digest()
            )
            conn.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n"
            )
            conn.sendall(bytes([0x82, 0x01, 0x00]))
            conn.sendall(bytes([0x89, 0x02]) + b"hi")
            send_text(conn, json.dumps({"jsonrpc": "2.0", "method": "event"}))
            send_text(conn, json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}))
            conn.settimeout(2)
            try:
                while conn.recv(4096):
                    pass
            except socket.timeout:
                pass

        got = self._ws(handler)
        self.assertEqual(got["driver"], True)
        self.assertEqual(got["protocol_version"], 2)

    def test_ws_upgrade_403_omits_body_and_ticket(self) -> None:
        def handler(conn: socket.socket) -> None:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            body = f"{SECRET} {TICKET}".encode()
            conn.sendall(
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: " + str(len(body)).encode()
                + b"\r\n\r\n" + body
            )

        with self.assertRaises(doctor.RpcError) as caught:
            self._ws(handler)
        self.assertEqual(str(caught.exception), "websocket upgrade failed: HTTP 403")
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn(TICKET, str(caught.exception))

    def test_ws_error_code_omits_server_message(self) -> None:
        def handler(conn: socket.socket) -> None:
            data = b""
            while b"\r\n\r\n" not in data:
                data += conn.recv(4096)
            key = b""
            for line in data.split(b"\r\n"):
                if line.lower().startswith(b"sec-websocket-key:"):
                    key = line.split(b":", 1)[1].strip()
            accept = __import__("base64").b64encode(
                hashlib.sha1(key + doctor.WS_GUID.encode()).digest()
            )
            conn.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n"
            )
            payload = json.dumps({
                "jsonrpc": "2.0", "id": 1,
                "error": {"code": -32601, "message": SECRET},
            }).encode()
            conn.sendall(bytes([0x81, len(payload)]) + payload)
            conn.settimeout(2)
            try:
                while conn.recv(4096):
                    pass
            except socket.timeout:
                pass

        with self.assertRaises(doctor.RpcError) as caught:
            self._ws(handler)
        self.assertEqual(str(caught.exception), "groups.capabilities error code -32601")
        self.assertNotIn(SECRET, str(caught.exception))

    def _ws(self, handler):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]

        def run() -> None:
            conn, _addr = server.accept()
            try:
                handler(conn)
            finally:
                conn.close()
                server.close()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            return doctor.ws_rpc(f"http://127.0.0.1:{port}", TICKET, "groups.capabilities", {}, 2)
        finally:
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
