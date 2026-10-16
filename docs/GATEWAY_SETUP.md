# Gateway setup on pavillion-claw

The app talks only to `hermes dashboard` at `https://pavillion-claw.tailfc1337.ts.net`. Telegram stays on `hermes gateway` and does not sync with the app or with Desktop.

Commands below were checked against NousResearch/hermes-agent `4e59ac2b883b4133ea8a2d299abac45189781c09` (the plan's `acc3cada` was not on the remote) and against Tailscale's serve docs as fetched 2026-10-16. hermes-agent does not document `tailscale serve`.

## What each process owns

| Process | Owns |
|---|---|
| `hermes dashboard` | The web UI and `/api/ws`. Desktop and the app connect here. On startup it also starts a hosted-room service (`hermes_cli/web_server_app.py`, `_start_hosted_rooms`). |
| `hermes gateway run` | Messaging platforms, including Telegram. It starts its own hosted-room worker (`gateway/run_startup.py`, `GatewayRunner._start_hosted_room_worker_sync`). The app uses the dashboard socket, not this process. |

Both open the root `shared-state.db` (`gateway/hosted_rooms.py`, `default_db_path`). Sessions stay in each profile's `state.db`. The room-driver lease stores `process_generation`, an in-memory UUID, not a PID (`tui_gateway/hosted_room_driver.py`, `HostedRoomRuntime.process_generation`). When both processes have the database open, the doctor warns and does not guess which one holds the epoch.

`hermes gateway install` writes a service whose `ExecStart` is `gateway run` (`hermes_cli/gateway.py`, the unit built around `installation_command(..., ["gateway", "run"])`). `hermes gateway status` is not that process.

## Password and the public URL

Tailscale Serve reverse-proxies only to `http://127.0.0.1` ([serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)). The dashboard therefore stays on loopback. A loopback bind alone leaves the auth gate off. The gate also turns on when `dashboard.public_url` names a non-loopback host (`hermes_cli/web_server.py`, `should_require_dashboard_auth`; `hermes_cli/web_server_boundary.py`, `public_hosts_engage_gate`). The same hostname is the Host value the loopback listener will accept (`_is_accepted_host`, `_dashboard_public_hosts`).

Loopback hosts are `127.0.0.1`, `::1`, and `localhost`. `--insecure` does not disable the gate.

This is not the recipe in the Hermes web-dashboard page. That page's worked example binds `--host 0.0.0.0`, and its Tailscale warning says to bind the tailscale IP and open `http://<tailscale-ip>:9119` (`website/docs/user-guide/features/web-dashboard.md`, "Connecting Hermes Desktop to a remote backend"). Those are direct HTTP listeners. This plan's URL is the HTTPS name from `tailscale serve`.

From the hermes-agent repo root (`plugins.dashboard_auth.basic` is that tree). The hash command, the three `HERMES_DASHBOARD_BASIC_AUTH_*` lines, and `chmod` are the worked example in that same page ("Worked example: username/password"). Replace `admin` and `choose-a-strong-password`. If those keys are already in `~/.hermes/.env`, edit them in place instead of appending a second copy. Do not commit that file.

```bash
HASH=$(python -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password('choose-a-strong-password'))")

cat >> ~/.hermes/.env <<EOF
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=$HASH
HERMES_DASHBOARD_BASIC_AUTH_SECRET=$(openssl rand -base64 32)
EOF
chmod 600 ~/.hermes/.env
```

Add this line once to the same file. `HERMES_DASHBOARD_PUBLIC_URL` wins over `dashboard.public_url` when it is non-empty (`hermes_cli/dashboard_auth/prefix.py`, `resolve_public_url`). The config key is documented on `dashboard.public_url` in `hermes_cli/config_defaults.py`.

```bash
printf '\nHERMES_DASHBOARD_PUBLIC_URL=https://pavillion-claw.tailfc1337.ts.net\n' >> ~/.hermes/.env
```

Equivalent YAML, if you set it in `~/.hermes/config.yaml` instead of the environment:

```yaml
dashboard:
  public_url: https://pavillion-claw.tailfc1337.ts.net
```

Do not start this dashboard with `HERMES_DESKTOP=1` and a dashboard session token. That combination is what exempts a Desktop-owned loopback backend from the public-url gate (`hermes_cli/web_server_boundary.py`, `_desktop_loopback_auth_exempt`). The pavillion-claw dashboard is the public one.

## Dashboard, then tailscale serve

Flags `--host`, `--port`, and `--no-open` are the web-dashboard options table. `--host 127.0.0.1` and `--port 9119` are the documented defaults, written out so this is not the worked example's `0.0.0.0` bind.

```bash
hermes dashboard --no-open --host 127.0.0.1 --port 9119
```

In another shell, serve that port in the background. A bare port is the documented proxy target (`tailscale serve 3000` proxies to `http://127.0.0.1:3000` in [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)). `--bg` keeps the config across reboot ([serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve), "Effects of rebooting and restarting"). HTTPS on the machine's MagicDNS name is the default. If the CLI prints a page for enabling HTTPS certificates, open it. Do not use `tailscale funnel`.

```bash
tailscale serve --bg 9119
tailscale serve status
```

`tailscale serve status` should show `https://pavillion-claw.tailfc1337.ts.net` with `/` proxied to `http://127.0.0.1:9119`. If the printed MagicDNS name is different, use the printed name.

Then confirm the gate on that HTTPS URL. The query is the one in the worked example (`curl …/api/status | jq '.auth_required, .auth_providers'`); `/api/status` is public (`hermes_cli/dashboard_auth/public_paths.py`). Expect `true` and a list that includes `basic`.

```bash
curl -s https://pavillion-claw.tailfc1337.ts.net/api/status | jq '.auth_required, .auth_providers'
```

A 400 on this URL with the gate still off on `http://127.0.0.1:9119` means the Host header is the tailnet name and `HERMES_DASHBOARD_PUBLIC_URL` is unset or was not loaded by the dashboard process. Restart `hermes dashboard` after editing `.env`.

## Headless bot markers

`agent.bot_mode_protocol` defaults to on (`website/docs/user-guide/bot-mode.md`, "What actually makes a chat a Bot Chat"). Two further conditions are required, and no CLI writes the second one. Repeat the command for each of the three bot profile ids. The title is exactly `Bot Chat`.

```bash
hermes -p <bot> chat -c "Bot Chat" --create-if-missing
```

Source: the same bot-mode section, and `hermes_cli/main.py` (`chat -c <title> --create-if-missing`).

Put this in any one profile's `profile.yaml` (an empty block is enough; one marked profile marks the install):

```yaml
ui_meta:
  hermes-bots: {}
```

Source: the same bot-mode section. Path: `~/.hermes/profiles/<bot>/profile.yaml`.

## Driver check

From a checkout of this repo on pavillion-claw, run [doctor.py](../scripts/gateway-doctor/doctor.py). `HERMES_DASHBOARD_USERNAME` and `HERMES_DASHBOARD_PASSWORD` are the doctor's variables. They are not `HERMES_DASHBOARD_BASIC_AUTH_*`. Pass the same username and the same password you hashed. The password is an environment variable, not a flag.

```bash
HERMES_DASHBOARD_USERNAME='admin' \
HERMES_DASHBOARD_PASSWORD='choose-a-strong-password' \
python3 scripts/gateway-doctor/doctor.py
```

Defaults are `~/.hermes` and `https://pavillion-claw.tailfc1337.ts.net` (`--home`, `--url`). Exit 1 when any row is fail. Warn alone exits 0.

`groups_capabilities` asks the dashboard. `driver is not true` means that process does not have a running hosted-room runtime (`tui_gateway/methods_groups.py`, the `groups.capabilities` handler). `driver_lease` warns when both the dashboard pid and the gateway pid have `shared-state.db` open: the lease does not store a pid, and a healthy box can look like that. Two different live `process_generation` values is a fail.

The messaging service, if it is not already running:

```bash
hermes gateway install
hermes gateway start
```

Source: `website/docs/user-guide/messaging/index.md`, "Gateway Commands".

## Patched-branch runbook

Deploy, rollback, and the upstream PR flow for the patched hermes-agent branch are not in this file.

TODO(HM-18)
