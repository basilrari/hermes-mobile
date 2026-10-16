# Gateway setup on pavillion-claw

The app talks only to `hermes dashboard` at `https://pavillion-claw.tailfc1337.ts.net`. Telegram stays on `hermes gateway` and does not sync with the app or with Desktop.

Commands below were checked against NousResearch/hermes-agent [`4e59ac2b883b4133ea8a2d299abac45189781c09`](https://github.com/NousResearch/hermes-agent/commit/4e59ac2b883b4133ea8a2d299abac45189781c09). The plan's `acc3cada` is not on the remote. hermes-mobile's checkout does not contain the hermes-agent tree; the line numbers were read from that commit on the remote. Tailscale's serve docs were fetched 2026-10-16.

## What each process owns

| Process | Owns |
|---|---|
| `hermes dashboard` | The web UI and `/api/ws`. Desktop and the app connect here. On startup it also starts a hosted-room service ([`web_server_app.py` `_start_hosted_rooms`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_app.py#L90-L104)). |
| `hermes gateway run` | Messaging platforms, including Telegram. It starts its own hosted-room worker ([`GatewayRunner._start_hosted_room_worker_sync`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/run_startup.py#L817-L829)). The app uses the dashboard socket, not this process. |

Both open the root `shared-state.db` ([`default_db_path`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_rooms.py#L404-L419)). Sessions stay in each profile's `state.db`. The room-driver lease is one row per room and stores `process_generation`, an in-memory UUID, not a PID ([`acquire_lease`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/gateway/hosted_room_driver.py#L532-L567), [`HostedRoomRuntime.process_generation`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/hosted_room_driver.py#L143-L143)). An open database is not a lease. The doctor prints `processes with the DB open` as information. Two live `process_generation` values on different rooms are a warning. A lease whose epoch disagrees with its room, or a lease for a `room_id` that is not in `hosted_rooms`, is a failure.

`hermes gateway install` writes a service whose `ExecStart` is `gateway run` ([`gateway.py` L3257-L3271](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/gateway.py#L3257-L3271)). `hermes gateway status` is not that process. If a gateway is already running in the foreground, replace it with [`hermes gateway run --replace`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/gateway.py#L4401-L4404) (the profile helper passes the same flag at [L932](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/gateway.py#L927-L932)). The service path stays `hermes gateway install` / `hermes gateway start`.

## Password and the public URL

Tailscale Serve reverse-proxies only to `http://127.0.0.1` ([serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)). The dashboard therefore stays on loopback. A loopback bind alone leaves the auth gate off. The gate also turns on when `dashboard.public_url` names a non-loopback host ([`should_require_dashboard_auth`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server.py#L364-L375), [`public_hosts_engage_gate`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_boundary.py#L116-L118)). The same hostname is the Host value the loopback listener will accept ([`_is_accepted_host`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_boundary.py#L79-L103)).

Loopback hosts are `127.0.0.1`, `::1`, and `localhost` ([`should_require_auth`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_boundary.py#L106-L113)). `--insecure` does not disable the gate.

The website documents this shape. Bind loopback, point the TLS proxy at `http://127.0.0.1:9119`, and set `dashboard.public_url` to the external HTTPS origin ([`web-dashboard.md` L1035-L1048](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/features/web-dashboard.md#L1035-L1048)). That section names Tailscale Serve: the tailnet HTTPS name is `dashboard.public_url`, and the origin still requires an auth provider. A different section still says to bind the tailscale IP and open `http://<tailscale-ip>:9119` ([L1178-L1179](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/features/web-dashboard.md#L1178-L1179)). This guide follows the reverse-proxy section and the code, not that HTTP bind.

Basil confirmed the Host check on this machine. `https://pavillion-claw.tailfc1337.ts.net` returned HTTP 400 until `HERMES_DASHBOARD_PUBLIC_URL` was set to that name. The 400 is the loopback listener rejecting a Host header that is not loopback and not a trusted public host.

Set the public URL before the first gated start. `HERMES_DASHBOARD_PUBLIC_URL` wins over `dashboard.public_url` when it is non-empty ([`resolve_public_url`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/dashboard_auth/prefix.py#L117-L130)). The config key is [`dashboard.public_url`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/config_defaults.py#L1060-L1066).

```bash
printf '\nHERMES_DASHBOARD_PUBLIC_URL=https://pavillion-claw.tailfc1337.ts.net\n' >> ~/.hermes/.env
```

Equivalent YAML, if you set it in `~/.hermes/config.yaml` instead of the environment:

```yaml
dashboard:
  public_url: https://pavillion-claw.tailfc1337.ts.net
```

The password never goes on a command line. On a TTY, [`_maybe_setup_dashboard_auth_interactively`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/main_dashboard.py#L608-L720) reads it with `getpass` ([L666-L672](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/main_dashboard.py#L666-L672)), writes `dashboard.basic_auth` in `config.yaml`, and re-enables the bundled provider when `basic` is listed in `plugins.disabled` ([L700-L704](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/main_dashboard.py#L700-L704)). Start the dashboard once in a terminal after the public URL is set and answer that prompt. A non-TTY start skips the prompt and fails closed.

To hash by hand, from the hermes-agent repo root, read the password into the environment and pass it on stdin. [`hash_password`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/plugins/dashboard_auth/basic/__init__.py#L51-L51) is the function the worked example calls. Do not put the password in the `python -c` text.

```bash
read -rs PASSWORD
printf '\n'
HASH=$(printf '%s' "$PASSWORD" | python -c 'import sys; from plugins.dashboard_auth.basic import hash_password; print(hash_password(sys.stdin.read()))')
unset PASSWORD
umask 077
cat >> ~/.hermes/.env <<EOF
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=$HASH
HERMES_DASHBOARD_BASIC_AUTH_SECRET=$(openssl rand -base64 32)
EOF
chmod 600 ~/.hermes/.env
unset HASH
```

Replace `admin` with the username you want. If those keys are already in `~/.hermes/.env`, edit them in place instead of appending a second copy. Do not commit that file. `$HASH` is the hash, not the password.

Then confirm `basic` is not an entry of `plugins.disabled` in `~/.hermes/config.yaml`. A listed `basic` means the provider does not register and the gate fails closed. The interactive setup removes that entry; a hand-written config does not.

Do not start this dashboard with `HERMES_DESKTOP=1` and a dashboard session token. That combination is what exempts a Desktop-owned loopback backend from the public-url gate ([`_desktop_loopback_auth_exempt`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/web_server_boundary.py#L121-L140)). The pavillion-claw dashboard is the public one.

## Dashboard, then tailscale serve

Flags `--host`, `--port`, and `--no-open` are the web-dashboard options table. `--host 127.0.0.1` and `--port 9119` are the documented defaults. The worked example's `0.0.0.0` bind is the other recipe.

Keep the process up across logout. The website says to run it under systemd or tmux ([`web-dashboard.md` L174](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/features/web-dashboard.md#L174-L174)). Its sample unit binds `0.0.0.0` ([L184-L196](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/features/web-dashboard.md#L184-L196)). This machine keeps `127.0.0.1`, because `tailscale serve` only proxies to loopback. Exit 78 means another backend already owns the host; `RestartPreventExitStatus=78` stops a restart loop. Substitute the venv python the install actually uses.

```ini
[Service]
EnvironmentFile=%h/.hermes/.env
ExecStart=/path/to/venv/bin/python -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --no-open
Restart=always
RestartSec=10
RestartPreventExitStatus=78
```

A foreground check, or a tmux session, is the same command:

```bash
hermes dashboard --no-open --host 127.0.0.1 --port 9119
```

In another shell, serve that port in the background. A bare port is the documented proxy target (`tailscale serve 3000` proxies to `http://127.0.0.1:3000` in [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)). `--bg` keeps the config across reboot ([serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)). HTTPS on the machine's MagicDNS name is the default. If the CLI prints a page for enabling HTTPS certificates, open it. Do not use `tailscale funnel`.

```bash
tailscale serve --bg 9119
tailscale serve status
```

`tailscale serve status` should show `https://pavillion-claw.tailfc1337.ts.net` with `/` proxied to `http://127.0.0.1:9119`. If the printed MagicDNS name is different, use the printed name in `HERMES_DASHBOARD_PUBLIC_URL` and restart the dashboard so it reloads `.env`.

Then confirm the gate on that HTTPS URL. `/api/status` is public ([`PUBLIC_API_PATHS`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/dashboard_auth/public_paths.py#L9-L15)). Expect `true` and a list that includes `basic`.

```bash
curl -s https://pavillion-claw.tailfc1337.ts.net/api/status | jq '.auth_required, .auth_providers'
```

HTTP 400 on the tailnet name, with the gate still off on `http://127.0.0.1:9119`, is the Host mismatch Basil hit. Set `HERMES_DASHBOARD_PUBLIC_URL` to the tailnet HTTPS name and restart the dashboard.

## Headless bot markers

`agent.bot_mode_protocol` defaults to on ([`bot-mode.md` "What actually makes a chat a Bot Chat"](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/bot-mode.md#L198-L216)). Two further conditions are required, and no CLI writes the second one. Repeat the command for each of the three bot profile ids. The title is exactly `Bot Chat`. The root install's `~/.hermes/state.db` is not one of those profiles.

```bash
hermes -p <bot> chat -c "Bot Chat" --create-if-missing
```

Source: the same bot-mode section, and [`hermes_cli/main.py` `_create_titled_session`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/main.py#L1379-L1425) (`chat -c <title> --create-if-missing`).

Put this in any one profile's `profile.yaml` (an empty block is enough; one marked profile marks the install):

```yaml
ui_meta:
  hermes-bots: {}
```

Source: the same bot-mode section. Path: `~/.hermes/profiles/<bot>/profile.yaml`.

## Driver check

From a checkout of this repo on pavillion-claw, run [doctor.py](../scripts/gateway-doctor/doctor.py). `HERMES_DASHBOARD_USERNAME` and `HERMES_DASHBOARD_PASSWORD` are the doctor's variables. They are not `HERMES_DASHBOARD_BASIC_AUTH_*`. The password is an environment variable, not a flag and not an argument. `read -rs` does not echo it.

```bash
read -rs HERMES_DASHBOARD_PASSWORD
printf '\n'
export HERMES_DASHBOARD_PASSWORD
HERMES_DASHBOARD_USERNAME=admin python3 scripts/gateway-doctor/doctor.py
unset HERMES_DASHBOARD_PASSWORD
```

Defaults are `~/.hermes` and `https://pavillion-claw.tailfc1337.ts.net` (`--home`, `--url`). Exit 1 when any row is fail. Warn alone exits 0.

`groups_capabilities` asks the dashboard. `driver is not true` means that process does not have a running hosted-room runtime ([`groups.capabilities`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/tui_gateway/methods_groups.py#L216-L245)). `driver_lease` passes when each live lease matches its room. Two live `process_generation` values on different rooms is a warn. An epoch that disagrees with its room, or a lease for an unknown room, is a fail. The line `processes with the DB open` names who has the file open. It does not say who holds the lease, and both processes having `shared-state.db` open is not a warn by itself.

The doctor posts `/auth/logout` after the capabilities call ([`auth_logout`](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/hermes_cli/dashboard_auth/routes.py#L496-L510)). A failed logout does not fail the row. The server session then stays open until its TTL.

The messaging service, if it is not already running:

```bash
hermes gateway install
hermes gateway start
```

Source: [`messaging/index.md` "Gateway Commands"](https://github.com/NousResearch/hermes-agent/blob/4e59ac2b883b4133ea8a2d299abac45189781c09/website/docs/user-guide/messaging/index.md#L169-L180). If `hermes gateway run` says a gateway is already running, use `hermes gateway run --replace` as cited above, or `hermes gateway restart` for the service.

## Patched-branch runbook

Deploy, rollback, and the upstream PR flow for the patched hermes-agent branch are not in this file.

TODO(HM-18)
