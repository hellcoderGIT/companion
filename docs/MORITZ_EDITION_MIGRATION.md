# Migrate `the-companion` → `@hellcoder/companion` (Moritz Edition)

Operational runbook for cutting a server over from the upstream
[`the-companion`](https://www.npmjs.com/package/the-companion) npm package to
this fork, [`@hellcoder/companion`](https://www.npmjs.com/package/@hellcoder/companion),
without losing any sessions, auth, recordings, agents, cron jobs, or settings.

This file is **not** part of the Mintlify docs site — it is an internal
operational doc intended to be handed to an automated agent (or read by a
human) on a target server. Copy the body below into a fresh Claude Code
session on the server you want to migrate.

---

## Context

The fork keeps the same binary names (`the-companion`, `companion`), the same
systemd / launchd service name, and the same state directory (`~/.companion/`),
so the cutover is a package swap plus one restart — no unit-file edits and no
config migration.

## Pre-flight — gather facts before changing anything

Run these checks first and **report their output** before proceeding. If any
check reveals something unexpected (different install path, container-based
install, macOS launchd, etc.), **stop and ask** rather than guessing.

```bash
# 1. Is it running? How?
#    Linux:  systemctl --user status the-companion.service
#    macOS:  launchctl list | grep thecompanion
systemctl --user status the-companion.service --no-pager 2>&1 | head -15 || \
  launchctl list 2>&1 | grep -i companion

# 2. Where is the binary? What package is behind it?
readlink -f "$(which the-companion)" 2>&1
# Expected symlink target looks like:
#   …/node_modules/the-companion/bin/cli.ts          (upstream)
#   …/node_modules/@hellcoder/companion/bin/cli.ts   (already migrated — skip)

# 3. What version is actually serving? (port defaults to 3456)
curl -sS http://localhost:3456/api/update-check 2>&1 | head -c 300

# 4. Verify state directory exists and has the expected subdirs
ls ~/.companion 2>&1
# Expect at least: auth.json, settings.json, sessions* or executions,
# agents, envs, cron, logs, recordings (some may be empty).

# 5. Confirm npm connectivity to our published package
curl -sS https://registry.npmjs.org/@hellcoder%2Fcompanion/latest \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['name'], d['version'])"
# Expect: @hellcoder/companion <version>
```

If step 1 shows **launchd on macOS**, the restart command at the end changes —
see the *macOS variant* lines in each step.

If step 2 shows **anything other than bun-installed global `the-companion`**
(for example, a Docker container, an npm install, or a source checkout via
`bun link`), stop and ask. The steps below assume
`bun install -g the-companion`.

## Safety rules

- **Never delete `~/.companion/`** — that is where all sessions, auth, and
  settings live.
- `bun remove -g` / `bun install -g` only touch
  `~/.bun/install/global/node_modules/`. They do **not** touch `~/.companion/`.
- Don't edit `~/.config/systemd/user/the-companion.service` — the unit name
  stays the same, the `ExecStart` path stays the same, the bin symlinks get
  repointed by bun.
- **Don't use `--force` or `--no-verify`** anywhere. If something objects,
  investigate rather than bypass.
- Take the state backup (step 1 below) before the install. It is cheap.

## Migration steps

### 1. Backup state

```bash
mkdir -p ~/backups
tar -czf ~/backups/companion-state-$(date +%Y%m%d-%H%M%S).tgz -C ~ .companion
ls -lh ~/backups/ | tail -3
```

Report the backup filename + size.

### 2. Stop the service

```bash
# Linux (matches pre-flight #1)
systemctl --user stop the-companion.service

# macOS variant:
# launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/sh.thecompanion.app.plist
```

### 3. Install the fork

```bash
# Pin a known version rather than "latest" — easier to roll back.
LATEST=$(curl -sS https://registry.npmjs.org/@hellcoder%2Fcompanion/latest \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
echo "Installing @hellcoder/companion@$LATEST"

bun install -g @hellcoder/companion@$LATEST
```

Both packages declare `bin: { the-companion, companion }`. Installing the
fork repoints the two symlinks in `~/.bun/bin/` to the new package. Verify:

```bash
readlink -f "$(which the-companion)"
# Must now end in: …/node_modules/@hellcoder/companion/bin/cli.ts
```

If the symlink still points at upstream, `bun install -g` didn't win the bin
conflict. Only then, run `bun remove -g the-companion` and redo the install.
Don't do this pre-emptively — removing leaves a brief window with no binary.

### 4. Start the service

```bash
# Linux
systemctl --user start the-companion.service
sleep 2
systemctl --user status the-companion.service --no-pager | head -10

# macOS variant:
# launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.thecompanion.app.plist
```

### 5. Verify

```bash
# Health
curl -sS http://localhost:3456/api/update-check 2>&1
# Expect: currentVersion == $LATEST, channel == "stable"

# Branding sanity check
curl -sS http://localhost:3456/ | grep -E 'title|Moritz'
# Expect: <title>The Companion — Moritz Edition</title>

# State intact: session list should still show the sessions that existed
# before the cutover (same session IDs, same models).
curl -sS http://localhost:3456/api/sessions 2>&1 | python3 -c \
  "import sys,json; [print(s['sessionId'][:8], s['model'], s['state']) for s in json.load(sys.stdin)]"
```

Then tell the user to **hard-reload the browser tab** (Ctrl+Shift+R /
Cmd+Shift+R). The PWA service worker caches the old bundle by asset hash —
after a version bump, a hard reload is needed to pick up the new hashes.
Without this, the tab may appear blank or look unchanged.

## Rollback — if anything is wrong after step 5

```bash
# Linux
systemctl --user stop the-companion.service
bun remove -g @hellcoder/companion
bun install -g the-companion@<previous-version>    # e.g. 0.95.0
systemctl --user start the-companion.service
```

State wasn't touched, so the old binary picks up where it left off. If even
that goes sideways, the tarball from step 1 restores everything:

```bash
systemctl --user stop the-companion.service
mv ~/.companion ~/.companion.broken-$(date +%s)
tar -xzf ~/backups/companion-state-<timestamp>.tgz -C ~
systemctl --user start the-companion.service
```

## When done — report back

- Pre-flight readings (installed version before, state dir size, npm package
  version targeted).
- Backup tarball path.
- `readlink -f $(which the-companion)` after install (proves symlink
  repointed).
- `/api/update-check` output after restart (proves running version = target).
- Whether the user confirmed the UI loaded and looks right after a hard
  reload.
