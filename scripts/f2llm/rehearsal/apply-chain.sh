#!/bin/bash
# Recreate the rehearsal database and apply the Supabase stubs + migrations 0001..(upto) to it.
#   scripts/f2llm/rehearsal/apply-chain.sh [last-migration-prefix, default: all]   (container: ysd-pg-rehearsal)
set -u
C=${YSD_PG_CONTAINER:-ysd-pg-rehearsal}
UPTO=${1:-9999}
cd "$(dirname "$0")/../../.."
docker exec "$C" psql -U postgres -d postgres -q -c "drop database if exists ysd with (force)" -c "create database ysd" >/dev/null
PSQL="docker exec -i $C psql -U postgres -d ysd -v ON_ERROR_STOP=1 -q"
$PSQL < scripts/f2llm/rehearsal/00_supabase_stubs.sql || { echo "stubs failed"; exit 1; }
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f" | cut -c1-4)
  [ "$((10#$n))" -gt "$((10#$UPTO))" ] && break
  last=$(basename "$f")
  out=$($PSQL < "$f" 2>&1) || { echo "FAILED at $(basename "$f"):"; echo "$out" | head -8; exit 1; }
done
echo "applied through ${last:-none}"
