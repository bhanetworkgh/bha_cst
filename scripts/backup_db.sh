cat > backup_bha_cst_postgres.sh <<'EOF'
#!/bin/bash
set -Eeuo pipefail
umask 077

# CST PostgreSQL backup
# Source: bha-cst-postgres on Render
# PostgreSQL client tools: version 16 recommended

BACKUP_DIR="$HOME/cst-db-backups"

export PGHOST="dpg-db8he2qvcj2c73ado3s0-a.oregon-postgres.render.com"
export PGPORT="5432"
export PGDATABASE="bha_cst_1sh0"
export PGUSER="bha_cst_user"
export PGSSLMODE="require"

for tool in pg_dump pg_restore; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is not installed." >&2
    exit 1
  fi
done

echo "PostgreSQL backup tool versions:"
pg_dump --version
pg_restore --version

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Prompt securely; never put the password in this script.
read -r -s -p "Enter the ROTATED Render database password: " PGPASSWORD
echo
export PGPASSWORD

BACKUP_FILE="$BACKUP_DIR/bha-cst-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"

cleanup() {
  unset PGPASSWORD
  unset PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE
}
trap cleanup EXIT

echo "Starting backup..."
pg_dump \
  --format=custom \
  --verbose \
  --no-password \
  --file="$BACKUP_FILE"

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "ERROR: Backup file is missing or empty." >&2
  exit 1
fi

echo "Checking that the archive can be read..."
pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.contents.txt"

if [[ ! -s "$BACKUP_FILE.contents.txt" ]]; then
  echo "ERROR: Archive listing is empty." >&2
  exit 1
fi

echo
echo "Backup completed and archive listing verified."
echo "Backup file: $BACKUP_FILE"
ls -lh "$BACKUP_FILE" "$BACKUP_FILE.contents.txt"

echo
echo "SHA-256 checksum:"
shasum -a 256 "$BACKUP_FILE"

echo
echo "NOTE: Archive listing is not a substitute for a restore test."
echo "Restore only into a dedicated non-production database."
EOF

chmod 700 backup_bha_cst_postgres.sh
bash -n backup_bha_cst_postgres.sh && echo "Script created and syntax check passed."