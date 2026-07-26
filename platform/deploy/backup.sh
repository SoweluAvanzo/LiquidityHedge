#!/bin/sh
# Nightly pg_dump + ledger archive, with retention. Runs inside the backup
# container on the internal network; artifacts land in the lh_backups
# volume, which the host ships offsite (restic/B2 — RB-6).
#
# A backup that "succeeds" while being empty is worse than a failed one:
# it looks fine until the restore. Every artifact is therefore validated
# before it is allowed to replace anything, and retention will never
# delete the last known-good copy.
set -eu
: "${PGHOST:=postgres}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
: "${BACKUP_DIR:=/backups}" "${RETENTION_DAYS:=14}" "${INTERVAL_SECONDS:=86400}"
: "${LEDGER_DIR:=/ledgers}"
# Floors: a real dump carries the pg_dump header plus the schema; a real
# ledger archive carries at least an empty-dir tar. Anything smaller is a
# truncated or failed write, not a small database.
: "${MIN_DUMP_BYTES:=2000}" "${MIN_LEDGER_BYTES:=100}"
: "${KEEP_MINIMUM:=3}"

mkdir -p "$BACKUP_DIR"

# Keep an artifact only if it is intact and plausibly sized.
# $1 = temp file, $2 = final name, $3 = minimum bytes, $4 = label
keep_if_valid() {
  tmp="$1"; final="$2"; floor="$3"; label="$4"
  size=$(stat -c%s "$tmp" 2>/dev/null || echo 0)
  if [ "$size" -lt "$floor" ]; then
    rm -f "$tmp"
    echo "$label BACKUP REJECTED: ${size}B < ${floor}B floor (empty or truncated)" >&2
    return 1
  fi
  if ! gzip -t "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "$label BACKUP REJECTED: gzip integrity check failed" >&2
    return 1
  fi
  mv "$tmp" "$final"
  echo "$label backup ok: $final (${size} bytes)"
  return 0
}

# Delete artifacts older than RETENTION_DAYS, but never drop below
# KEEP_MINIMUM copies — otherwise a fortnight of silent failures would
# leave nothing at all to restore from.
prune() {
  pattern="$1"
  total=$(find "$BACKUP_DIR" -name "$pattern" | wc -l)
  [ "$total" -le "$KEEP_MINIMUM" ] && return 0
  find "$BACKUP_DIR" -name "$pattern" -mtime "+$RETENTION_DAYS" | sort | \
    head -n "$((total - KEEP_MINIMUM))" | while read -r old; do
      rm -f "$old" && echo "pruned $old"
    done
}

while true; do
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  ok_db=0
  ok_ledger=0

  # ── PostgreSQL ────────────────────────────────────────────────────
  OUT="$BACKUP_DIR/lh_${STAMP}.sql.gz"
  if pg_dump --no-owner --no-privileges 2>/dev/null | gzip -1 > "$OUT.tmp"; then
    keep_if_valid "$OUT.tmp" "$OUT" "$MIN_DUMP_BYTES" "postgres" && ok_db=1
  else
    rm -f "$OUT.tmp"
    echo "postgres BACKUP FAILED at $STAMP (pg_dump error — server down?)" >&2
  fi

  # ── Ledgers (certificates + orders: the record of who paid what) ──
  if [ -d "$LEDGER_DIR" ]; then
    LOUT="$BACKUP_DIR/ledgers_${STAMP}.tar.gz"
    if tar czf "$LOUT.tmp" -C "$LEDGER_DIR" . 2>/dev/null; then
      keep_if_valid "$LOUT.tmp" "$LOUT" "$MIN_LEDGER_BYTES" "ledger" && ok_ledger=1
    else
      rm -f "$LOUT.tmp"
      echo "ledger BACKUP FAILED at $STAMP" >&2
    fi
  else
    echo "WARNING: ledger dir $LEDGER_DIR not mounted — ledgers NOT backed up" >&2
  fi

  # Prune only after a good cycle: while backups are failing, keep every
  # existing copy regardless of age.
  if [ "$ok_db" -eq 1 ]; then prune 'lh_*.sql.gz'; fi
  if [ "$ok_ledger" -eq 1 ]; then prune 'ledgers_*.tar.gz'; fi
  [ "$ok_db" -eq 1 ] && [ "$ok_ledger" -eq 1 ] || \
    echo "CYCLE INCOMPLETE at $STAMP (db=$ok_db ledger=$ok_ledger) — investigate (RB-6)" >&2

  sleep "$INTERVAL_SECONDS"
done
