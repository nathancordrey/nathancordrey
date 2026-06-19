#!/usr/bin/env bash
#
# Nightly backup of the World Cup pool data.
# Copies data/worldcup.json to a timestamped file under backups/,
# but only if the file is valid JSON, and prunes old snapshots.
#
# Set it up with cron (see bottom of this file).

set -euo pipefail

# ── Adjust these if your layout differs ─────────────────────────────
APP_DIR="/home/nathan/code/nathancordrey"
SRC="$APP_DIR/data/worldcup.json"
BACKUP_DIR="$APP_DIR/backups"
RETENTION_DAYS=30          # delete snapshots older than this
# ────────────────────────────────────────────────────────────────────

log() { echo "$(date '+%F %T') $*"; }

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$SRC" ]]; then
    log "ERROR: $SRC not found — nothing to back up." >&2
    exit 1
fi

# Don't back up a corrupted file: confirm it parses as JSON first.
if ! python3 -c "import json; json.load(open('$SRC'))" 2>/dev/null; then
    log "ERROR: $SRC is not valid JSON — skipping backup." >&2
    exit 1
fi

TS="$(date '+%Y%m%d-%H%M%S')"
DEST="$BACKUP_DIR/worldcup-$TS.json"
cp -p "$SRC" "$DEST"
log "Backed up -> $DEST"

# Prune snapshots older than the retention window.
DELETED="$(find "$BACKUP_DIR" -name 'worldcup-*.json' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
if [[ "$DELETED" -gt 0 ]]; then
    log "Pruned $DELETED snapshot(s) older than $RETENTION_DAYS days."
fi

# ── Cron setup (run `crontab -e` and add one line) ──────────────────
#   Nightly at 3:30am, logging to backups/backup.log:
#
#   30 3 * * * /home/nathan/code/nathancordrey/backup_worldcup.sh >> /home/nathan/code/nathancordrey/backups/backup.log 2>&1
#
# Make the script executable first:
#   chmod +x /home/nathan/code/nathancordrey/backup_worldcup.sh
