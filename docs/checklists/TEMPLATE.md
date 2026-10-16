# Tablet checklist — <milestone>

Written by the lead from the milestone's acceptance criteria. Basil runs it by
hand on his Android tablet against `https://pavillion-claw.tailfc1337.ts.net`.
No adb, no bot driving the device. **Budget: about 5 minutes.** Tick each line;
where it says *screenshot*, capture the screen and attach it to the milestone
issue/PR.

Before starting: install the debug APK from the milestone's release
(`adb` is not needed — open the release's `.apk` link on the tablet), or update
the existing install. The app ID is `io.github.basilrari.hermesmobile`.

| # | Step | Expected | ☐ |
|---|---|---|---|
| 1 | Launch the app; enter the gateway URL | the URL field accepts only `https://…` | ☐ |
| 2 | Sign in (password or session token) | you reach the chat UI; no error toast | ☐ |
| 3 | Force-stop the app, relaunch | the session is kept — no re-login | ☐ |
| 4 | Rotate to landscape, then back | Sessions / Bots tabs stay usable in both | ☐ |
| 5 | Open a single-bot session; send one short prompt | a streamed reply arrives | ☐ |
| 6 | Long-press the version badge (bottom-left) | share sheet offers the RPC trace | ☐ |
| 7 | *screenshot:* the screen named in the milestone | — | ☐ |

Notes / failures (what you saw, at which step): 

Milestone-specific steps go below this line when the lead adds them.
