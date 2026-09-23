#!/usr/bin/env bash
# Logical copy of the tables the cutover writes to — READ-ONLY (SELECT via the Management API,
# no Docker/pg_dump needed). Output stays on the operator's machine: it contains user file text.
#
#   scripts/cutover/export-tables.sh <outDir> <expectedProjectRef>
set -u
OUT="$1"; REF="$2"
[ "$(cat supabase/.temp/project-ref 2>/dev/null)" = "$REF" ] || { echo "REFUSING: supabase CLI is not linked to $REF"; exit 2; }
mkdir -p "$OUT"
PAGE=100
for table in files file_chunks rag_jobs; do
  : > "$OUT/$table.jsonl"
  offset=0; total=0
  while :; do
    rows=$(timeout 180 npx --yes supabase db query \
      "select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) as page from (select * from public.$table order by id limit $PAGE offset $offset) t;" \
      --linked -o json 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=d.indexOf("[");const r=JSON.parse(d.slice(s,d.lastIndexOf("]")+1));const page=r[0].page;for(const row of page)console.log(JSON.stringify(row))})') \
      || { echo "EXPORT FAILED: $table offset=$offset"; exit 1; }
    n=$(printf '%s' "$rows" | grep -c '^{' || true)
    [ "$n" -eq 0 ] && break
    printf '%s\n' "$rows" >> "$OUT/$table.jsonl"
    total=$((total + n)); offset=$((offset + PAGE))
  done
  expected=$(timeout 120 npx --yes supabase db query "select count(*) as n from public.$table;" --linked -o json 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=d.indexOf("[");console.log(JSON.parse(d.slice(s,d.lastIndexOf("]")+1))[0].n)})')
  echo "$table exported=$total expected=$expected"
  [ "$total" = "$expected" ] || { echo "EXPORT INCOMPLETE: $table"; exit 1; }
done
echo "EXPORT OK -> $OUT"
