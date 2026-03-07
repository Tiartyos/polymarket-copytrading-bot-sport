# Rolling Hourly Backups with Crontab

Automatic hourly backups that keep the last **12 hours** (configurable) and delete older ones.

---

## How It Works

The backup script (`scripts/backup.ts`):
- Auto-detects **docker** or **local** mode
- Creates `backups/backup-<timestamp>/data/` with all SQLite files
- Prunes the oldest backup when the count reaches `MAX_BACKUPS` (default: 12)
- Writes a `meta.json` alongside each backup for traceability

Rolling window: with `MAX_BACKUPS=12` and an hourly cron you always have the last **12 hours** recoverable.

---

## Quick Commands

```bash
# Manual backup
npm run backup

# Manual restore (latest)
npm run restore:latest

# Restore a specific snapshot
npm run restore -- backup-2026-03-07T10-00-00

# Override max backups (e.g. keep 24 hours)
MAX_BACKUPS=24 npm run backup
```

---

## 1. Prerequisites

Install **Node.js** and ensure `npx tsx` works in your shell:

```bash
node --version    # v18+
tsx --version     # or: npx tsx --version
```

Confirm the project path (used in cron commands below):

```bash
# Find the absolute path to this project
pwd
# Example: /home/user/polymarket-bot
```

---

## 2. Linux / macOS — Native Crontab

### Step 1 — Open your crontab

```bash
crontab -e
```

On first run it will ask you to choose an editor. Pick `nano` (option 1) if unsure.

### Step 2 — Determine Node / npm paths

Cron runs with a minimal PATH. Find the full paths:

```bash
which node   # e.g. /usr/local/bin/node   or  /home/user/.nvm/versions/node/v20.x.x/bin/node
which npm    # e.g. /usr/local/bin/npm
which npx    # e.g. /usr/local/bin/npx
```

### Step 3 — Add the cron rule

Paste this at the bottom of your crontab (replace the example paths):

```cron
# Polymarket bot — backup every hour, keep last 12
0 * * * * cd /home/user/polymarket-bot && /usr/local/bin/npx tsx scripts/backup.ts >> backups/cron.log 2>&1
```

Format: `minute hour day month weekday command`
- `0 * * * *` = at minute 0 of every hour

### Step 4 — Save and verify

In `nano`: press `Ctrl+X`, then `Y`, then `Enter`.

Verify the entry was saved:

```bash
crontab -l
```

### Step 5 — Test it immediately

```bash
# Run ad-hoc to confirm there are no PATH issues
cd /home/user/polymarket-bot && /usr/local/bin/npx tsx scripts/backup.ts
ls backups/
```

---

## 3. Windows — WSL2 (Ubuntu)

WSL2 cron requires manual service start each Windows boot (or use a startup script).

### Step 1 — Open WSL2 terminal

```powershell
wsl
```

### Step 2 — Enable and start the cron service

```bash
# Install cron if missing
sudo apt-get install -y cron

# Start cron service (must be done after every WSL restart)
sudo service cron start

# Or enable on WSL startup via ~/.bashrc or /etc/wsl.conf (see note below)
```

**Auto-start on WSL boot** — add to `/etc/wsl.conf`:

```ini
[boot]
command = service cron start
```

Then restart WSL: in PowerShell run `wsl --shutdown` and reopen WSL.

### Step 3 — Note your WSL project path

Your Windows path `D:\webdesign\...\polymarket-bot` maps to WSL as:

```bash
/mnt/d/webdesign/moje/betting/polymarket-copytrading-bot-sport-fork
```

### Step 4 — Set up crontab

```bash
crontab -e
```

Add:

```cron
# Polymarket bot — hourly backup, keep last 12
0 * * * * cd /mnt/d/webdesign/moje/betting/polymarket-copytrading-bot-sport-fork && /usr/local/bin/npx tsx scripts/backup.ts >> backups/cron.log 2>&1
```

### Step 5 — Verify

```bash
crontab -l
sudo service cron status
```

---

## 4. Windows — Task Scheduler (Native, no WSL)

More reliable than WSL cron for always-on Windows machines.

### Step 1 — Create a wrapper batch file

Create `scripts\backup.bat` in the project root:

```bat
@echo off
cd /d D:\webdesign\moje\betting\polymarket-copytrading-bot-sport-fork
npx tsx scripts/backup.ts >> backups\cron.log 2>&1
```

### Step 2 — Open Task Scheduler

Press `Win+R` → type `taskschd.msc` → Enter.

### Step 3 — Create a new task

1. In the right panel click **Create Basic Task…**
2. **Name**: `Polymarket Bot Backup`
3. **Trigger**: Daily → set start time → check **Repeat task every: 1 hour** for a duration of **1 day** → click **Indefinitely**
4. **Action**: Start a program → Browse to your `scripts\backup.bat`
5. Finish

### Step 4 — Verify

Right-click the task → **Run** → check `backups\cron.log`.

---

## 5. Customising the Rolling Window

Change `MAX_BACKUPS` to control how many hourly snapshots are kept:

| Keep last N hours | Setting              |
|-------------------|----------------------|
| 12 h (default)    | `MAX_BACKUPS=12`     |
| 24 h              | `MAX_BACKUPS=24`     |
| 48 h              | `MAX_BACKUPS=48`     |

Pass inline from cron:

```cron
0 * * * * cd /path/to/bot && MAX_BACKUPS=24 /usr/local/bin/npx tsx scripts/backup.ts >> backups/cron.log 2>&1
```

---

## 6. Restoring from a Backup

### List available backups

```bash
ls -1 backups/
# backup-2026-03-07T10-00-00
# backup-2026-03-07T11-00-00
# backup-2026-03-07T12-00-00   ← newest
```

### Restore the latest snapshot

```bash
npm run restore:latest
```

### Restore a specific snapshot

```bash
npm run restore -- backup-2026-03-07T10-00-00
```

### Docker restore notes

The restore script pushes files back into the container via `docker compose cp`.
After restoring, restart the bot to reload the database:

```bash
docker compose restart bot
```

If the container has never been started (fresh machine), run it once first so Docker creates the named volume:

```bash
docker compose up -d
# Then restore
npm run restore:latest
docker compose restart bot
```

### Local restore notes

The restore script automatically renames the existing `data/` to `data-pre-restore-<timestamp>/` before overwriting, so you can roll back the rollback if needed.

---

## 7. Monitoring Cron Logs

```bash
# Follow live
tail -f backups/cron.log

# Check last 20 lines
tail -20 backups/cron.log
```

A successful run ends with:

```
[backup] ✓ Backup complete
```
