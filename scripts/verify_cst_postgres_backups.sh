#!/usr/bin/env bash
# Read-only inventory/format validation for local CST PostgreSQL backup artifacts.
# Does not connect to a database, restore data, or modify backup files.
set -euo pipefail

BACKUP_DIR="${1:-$HOME/cst-db-backups}"
if [[ ! -d "$BACKUP_DIR" ]]; then
  printf 'ERROR: backup directory not found: %s\n' "$BACKUP_DIR" >&2
  printf 'Usage: %s [backup-directory]\n' "$0" >&2
  exit 2
fi

command -v shasum >/dev/null 2>&1 || { echo 'ERROR: shasum is required.' >&2; exit 2; }
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if stat -f '%z' "$BACKUP_DIR" >/dev/null 2>&1; then
  stat_size() { stat -f '%z' "$1"; }
  stat_mtime() { stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S%z' "$1"; }
else
  stat_size() { stat -c '%s' "$1"; }
  stat_mtime() { stat -c '%y' "$1"; }
fi

found=0
failed=0
printf 'CST PostgreSQL backup verification (read-only)\nDirectory: %s\n\n' "$BACKUP_DIR"

while IFS= read -r -d '' f; do
  found=$((found + 1))
  size="$(stat_size "$f")"
  mtime="$(stat_mtime "$f")"
  sha="$(shasum -a 256 "$f" | awk '{print $1}')"
  printf 'FILE: %s\n  bytes: %s\n  modified: %s\n  sha256: %s\n' "$(basename "$f")" "$size" "$mtime" "$sha"

  if [[ "$size" -eq 0 ]]; then
    echo '  result: FAIL — zero-byte file'
    failed=$((failed + 1))
  else
    case "$f" in
      *.dump|*.backup|*.pgdump)
        if command -v pg_restore >/dev/null 2>&1 && pg_restore --list "$f" >"$TMP_DIR/toc.txt" 2>"$TMP_DIR/restore.err"; then
          toc_count="$(grep -cE '^[0-9]+;' "$TMP_DIR/toc.txt" || true)"
          printf '  format: pg_restore-readable archive\n  toc_entries: %s\n  result: PASS\n' "$toc_count"
        else
          echo '  result: FAIL — pg_restore --list failed or pg_restore is unavailable'
          if [[ -s "$TMP_DIR/restore.err" ]]; then sed -n '1,3p' "$TMP_DIR/restore.err" | sed 's/^/  detail: /'; fi
          failed=$((failed + 1))
        fi
        ;;
      *.sql.gz|*.dump.gz|*.backup.gz)
        if command -v gzip >/dev/null 2>&1 && gzip -t "$f"; then
          echo '  format: gzip stream valid (SQL/archive contents not otherwise validated)'
          echo '  result: PASS'
        else
          echo '  result: FAIL — gzip integrity check failed or gzip unavailable'
          failed=$((failed + 1))
        fi
        ;;
      *.sql)
        echo '  format: plain SQL; non-empty and hashed only (no restore attempted)'
        echo '  result: REVIEW — syntax/restore not tested to avoid database writes'
        ;;
      *)
        echo '  format: unknown extension; non-empty and hashed only'
        echo '  result: REVIEW'
        ;;
    esac
  fi
  printf '\n'
done < <(find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.backup' -o -name '*.pgdump' -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.dump.gz' -o -name '*.backup.gz' \) -print0)

if [[ "$found" -eq 0 ]]; then
  echo 'ERROR: no recognized backup files found.' >&2
  exit 2
fi
printf 'Summary: %s backup file(s) inspected; %s failure(s).\n' "$found" "$failed"
if [[ "$failed" -ne 0 ]]; then exit 1; fi
