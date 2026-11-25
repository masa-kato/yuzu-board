# Running the Yuzu Board on the Pi

The live app runs on a Raspberry Pi at **<http://yuzuberrypi.local>**, and the Pi holds the one database everyone writes to. Away from home, your own devices reach it through Tailscale ([Away from home](#away-from-home)). The Mac is where the code is changed and tried out, and it keeps a copy of the Pi's data in case the Pi fails.

```
Mac:  edit ─► test app :5051 (a copy of the data) ─► commit ─► push (the tests run first)
                                                                 │
GitHub main ◄────────────────────────────────────────────────────┘
     │  the Pi checks every 2 minutes
     ▼
Pi:   test the new commit ─► snapshot the database ─► switch and restart ─► answers as the new version?
                                                                            no: back to the last one
Pi:   a snapshot of the database every 15 minutes ──► the Mac copies them, and the hold images, every 15 minutes
```

## The daily loop

1. Start the test app: `deploy/mac/test-app.sh`. It runs this working copy, changes and all, on port 5051, against a copy of the live data. Open <http://localhost:5051>, or the address it prints on a phone. Every page there has an orange outline and a "Test copy" tag, and nothing done there touches the real logbook.
2. Change the code. The test app restarts itself when a `.py` file changes; a `.js` or `.css` change shows on reload. `deploy/mac/test-app.sh --fresh` starts again on a new copy of the newest data.
3. Commit and push to `main`. The push runs the tests first and stops if they fail (`.githooks/pre-push`).
4. Within about 2 minutes the Pi has it. `deploy/mac/status.sh` shows what the Pi runs next to this checkout and GitHub. Phones that have the app open need a full reload to pick it up.

## Where things are

| | |
|---|---|
| **Pi** `~/yuzu-board/` | The live code: a checkout of `main` with its `.venv/`. Never edited by hand; every deploy resets it. |
| **Pi** `~/yuzu-staging/` | A second checkout, where each new commit is tested before the live app gets it |
| **Pi** `~/yuzu-data/homewall.db` | **The** database |
| **Pi** `~/yuzu-data/uploads/holds/` | The hold images |
| **Pi** `~/yuzu-data/backups/` | Snapshots of the database: every 15 minutes, and before each deploy |
| **Pi** `~/yuzu-data/deploy/` | The last deploy's result (`status.json`), a commit that failed, and the `paused` switch |
| **Mac** `~/YuzuBoard/replica/` | The copy of the Pi's snapshots and hold images |
| **Mac** `~/YuzuBoard/test/` | The test app's data |
| **Mac** `~/YuzuBoard/logs/sync.log` | What the sync job did |

The services on the Pi are systemd user services, which start at boot without anyone logging in:

| | |
|---|---|
| `yuzu-board` | The app, served by waitress on port 80 (`wsgi.py`). Restarts if it stops. |
| `yuzu-update.timer` | A minute after boot, then every 2 minutes: `deploy/pi/update.sh` |
| `yuzu-backup.timer` | Every 15 minutes: a snapshot, then old ones pruned (`backup.py`) |
| `yuzu-name.timer` | Every minute: takes `yuzuberrypi.local` back if the Pi's name service moved it to `yuzuberrypi-2.local`, which it can do at boot after hearing an echo of itself (`deploy/pi/keep-name.sh`) |

A deploy updates the code, not these services: after changing `deploy/pi/systemd/`, run `ssh yuzu '~/yuzu-board/deploy/pi/install.sh'` once it's live. It needs no password after the first time.

Snapshots are kept by age, on the Pi and the Mac alike: every one from the last 48 hours, then the last of each day for 60 days, then the last of each month. The Mac never deletes a copy because it went from the Pi.

## How a deploy goes

`deploy/pi/update.sh` runs every 2 minutes. When GitHub's `main` has a commit the Pi isn't running, it:

1. Checks the commit out in `~/yuzu-staging` and runs the tests there, installing any new requirements. If they fail, nothing else happens: the live app stays as it is, and that commit isn't tried again.
2. Takes a snapshot of the database, tagged `pre-deploy-<commit>`, since the new code's migrations run as it starts.
3. Moves `~/yuzu-board` to the commit and restarts the app.
4. Waits up to 30 seconds for `/api/health` to answer with the new commit. If it doesn't, it goes back to the last commit and restarts again.

The Mac shows a notification when a deploy fails (from the next sync). Its log on the Pi: `journalctl --user-unit yuzu-update`.

## Setting it up

**The Pi** (a fresh Raspberry Pi OS card with SSH on, reachable as `ssh yuzu`):

```sh
ssh yuzu 'git clone https://github.com/masa-kato/yuzu-board.git ~/yuzu-board'
ssh -t yuzu '~/yuzu-board/deploy/pi/install.sh'     # asks for the Pi's password once
```

The installer makes the Python environment and the folders, installs the services, and makes two system settings: services that start at boot without a login (linger), and port 80 without root. Last, it sets up Tailscale ([Away from home](#away-from-home)): open the links it prints. It's safe to run again. Then give it the data, either from the Mac's replica (`deploy/mac/failback.sh --from-replica`) or, the first time, by copying `homewall.db` and `uploads/holds/` into `~/yuzu-data/` and running `ssh yuzu systemctl --user start yuzu-board`.

**The Mac:**

```sh
deploy/mac/install.sh
```

This makes `~/YuzuBoard`, a key the Pi lets read `~/yuzu-data` and nothing else (no shell, no writes), the sync job (LaunchAgent `com.yuzuboard.sync`), and turns on the pre-push hook. Run it again after changing `deploy/mac/sync-from-pi.sh` or `backup.py`: the sync job runs from copies in `~/YuzuBoard/bin`, since background jobs can't read `~/Documents`.

## Away from home

[Tailscale](https://tailscale.com) puts the Pi and your own devices on a private network of their own, so the app works wherever they have internet, at two addresses only they can open:

- `https://yuzuberrypi.<your-tailnet>.ts.net`, with a certificate from Tailscale. `ssh yuzu tailscale serve status` prints it. This is the one to add to the Home Screen.
- `http://yuzuberrypi`, plain HTTP, though Tailscale still encrypts it on the way.

No ports are open on the router and nothing is public. Everyone else at home keeps using `http://yuzuberrypi.local`. Each address keeps its own logins, so the admin logs in once on each (see [Moving to a new address](#when-somethings-wrong)).

**Setting it up.** The Pi's installer does the Pi's part. It installs Tailscale and prints a link to log the Pi in to your Tailscale account. The first time, it prints another link to allow HTTPS for the account. Then:

1. In the Tailscale console, under **Machines**, open yuzuberrypi's **⋯** menu and choose **Disable key expiry**. Otherwise the Pi drops off after 180 days until it's logged in again.
2. On a phone, install the Tailscale app, sign in to the same account, and leave it on. Only traffic to your devices goes through it.

**Checking on it:**

```sh
ssh yuzu tailscale status          # the devices on it, and which are online
ssh yuzu tailscale serve status    # the HTTPS address and where it goes
```

Tailscale runs as a system service (`tailscaled`), not as one of the user services above, and updates itself. The installer lets you run `tailscale` on the Pi without `sudo`.

## When something's wrong

**What's running?** `deploy/mac/status.sh`, or on the Pi:

```sh
systemctl --user status yuzu-board yuzu-update.timer yuzu-backup.timer yuzu-name.timer
journalctl --user-unit yuzu-board -n 50       # the app
journalctl --user-unit yuzu-update -n 50      # deploys
```

Raspberry Pi OS keeps these logs in memory to spare the SD card, so they start again at each boot; the last deploy's result stays in `~/yuzu-data/deploy/status.json`.

**Undo a change** that's already live: `git revert` it on the Mac and push. The Pi always follows `main`, so resetting its checkout by hand only lasts until the next check.

**Pause deploys:** `ssh yuzu touch ~/yuzu-data/deploy/paused`, and `rm` it to carry on.

**Go back to a snapshot** (after a migration went wrong, say):

```sh
ssh yuzu
systemctl --user stop yuzu-board
ls ~/yuzu-data/backups                                   # pre-deploy-… ones are from just before a deploy
cp ~/yuzu-data/backups/homewall-YYYYMMDD-HHMM.db ~/yuzu-data/homewall.db
systemctl --user start yuzu-board
```

Anything logged since that snapshot is lost, so pick the newest one that's right.

**The Pi is down:** serve the Mac's copy instead.

```sh
deploy/mac/failover.sh
```

It serves the newest synced snapshot on port 5050 and prints the address for the phones (`http://<the Mac's address>:5050`). It refuses while the Pi still answers, so the two never both take writes. Stop it with Ctrl-C and run it again to carry on: it keeps the data it served. When the Pi is back, stop it and run:

```sh
deploy/mac/failback.sh
```

This copies the data the Mac served onto the Pi (keeping what the Pi had as a `before-failback` snapshot) and starts the app there.

**A dead SD card:** flash a new one with the same hostname and user, set the Pi up as above, then `deploy/mac/failback.sh --from-replica` puts the newest synced data on it. Anything logged after that snapshot (at most about 30 minutes) is lost.

**Moving to a new address:** logins and "who am I" are kept per address, so after the Pi's address changes, each phone chooses its climber and the admin logs in again. Add the new address to the Home Screen.
