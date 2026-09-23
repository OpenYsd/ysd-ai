#!/usr/bin/env bash
# Post-cutover watch. READ-ONLY: curl, railway logs/metrics, and SELECT queries.
#
#   scripts/cutover/monitor.sh <service> <environment> <deploymentId> <baseUrl> <minutes> [expectedProjectRef]
#
# Exits 0 when every tick passes for the whole window, 1 on the first hard failure
# (the rollback trigger), 2 on bad usage. One line per tick.
#
# Hard failures (rollback): /api/live not 200 twice in a row; health "failing" > 0 twice
# in a row; more than one server boot in the deployment (restart/OOM); any OOM marker;
# memory at or above 95% of the limit; any scope_query_failed / file_context_failed;
# a rag job stalled (running with heartbeat > 150 s old, or queued > 5 min) on two ticks.
set -u
SERVICE="$1"; ENVIRONMENT="$2"; DEPLOYMENT="$3"; BASE="${4%/}"; MINUTES="$5"; REF="${6:-}"
[ -n "$SERVICE" ] && [ -n "$DEPLOYMENT" ] && [ -n "$BASE" ] && [ -n "$MINUTES" ] || { echo "usage"; exit 2; }
if [ -n "$REF" ] && [ "$(cat supabase/.temp/project-ref 2>/dev/null)" != "$REF" ]; then
  echo "REFUSING: supabase CLI is not linked to $REF"; exit 2
fi
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END=$(( $(date +%s) + MINUTES * 60 ))
live_bad=0; health_bad=0; stall_bad=0; tick=0
while [ "$(date +%s)" -lt "$END" ]; do
  tick=$((tick + 1))
  live=$(curl -s -m 20 -o /dev/null -w "%{http_code}" "$BASE/api/live")
  health=$(curl -s -m 30 "$BASE/api/health")
  failing=$(printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).checks.failing)}catch{console.log("?")}})')
  passing=$(printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).checks.passing)}catch{console.log("?")}})')
  logs=$(timeout 150 railway logs "$DEPLOYMENT" --deployment -n 5000 2>/dev/null)
  boots=$(printf '%s\n' "$logs" | grep -c 'Ready in')
  # في الإنتاج لا يُطبع هذا السطر إلّا من فرع الموافقة الصريحة (وإلّا: "ignored")
  f2llm=$(printf '%s\n' "$logs" | grep -c '\[entrypoint\] f2llm space.*V8 heap capped at 192MB')
  oom=$(printf '%s\n' "$logs" | grep -ciE 'heap limit|out of memory|Killed|SIGKILL|FATAL ERROR')
  scope=$(printf '%s\n' "$logs" | grep -cE 'scope_query_failed|file_context_failed')
  mem=$(timeout 90 railway metrics --service "$SERVICE" --environment "$ENVIRONMENT" --memory --since "$START" --json 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const m=JSON.parse(d).memory;const a=Math.round(m.max_mb),b=Math.round(m.limit_mb);console.log(Number.isFinite(a)&&Number.isFinite(b)&&b>0?a+"/"+b:"?/?")}catch{console.log("?/?")}})')
  stalled=$(timeout 120 npx --yes supabase db query "select count(*) as n from rag_jobs where (status::text='running' and heartbeat_at < now() - interval '150 seconds') or (status::text in ('queued','retrying') and available_at < now() - interval '5 minutes');" --linked -o json 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=d.indexOf("[");console.log(JSON.parse(d.slice(s,d.lastIndexOf("]")+1))[0].n)}catch{console.log("?")}})')
  echo "$(date -u +%H:%M:%S) tick=$tick live=$live health=${passing}ok/${failing}fail boots=$boots f2llm_entry=$f2llm oom=$oom scope_err=$scope mem=${mem}MB stalled_jobs=$stalled"

  [ "$live" = "200" ] && live_bad=0 || live_bad=$((live_bad + 1))
  [ "$failing" = "0" ] && health_bad=0 || health_bad=$((health_bad + 1))
  [ "$stalled" = "0" ] && stall_bad=0 || stall_bad=$((stall_bad + 1))
  max=${mem%%/*}; lim=${mem##*/}
  fail=""
  [ "$live_bad" -ge 2 ] && fail="$fail live"
  [ "$health_bad" -ge 2 ] && fail="$fail health"
  [ "$boots" -gt 1 ] && fail="$fail restart"
  [ "$f2llm" -lt 1 ] && [ "$boots" -ge 1 ] && fail="$fail not_f2llm"
  [ "$oom" -gt 0 ] && fail="$fail oom"
  [ "$scope" -gt 0 ] && fail="$fail scope_errors"
  [ "$stall_bad" -ge 2 ] && fail="$fail stalled_jobs"
  if [ "$max" != "?" ] && [ "$lim" != "?" ] && [ "$max" -ge $(( lim * 95 / 100 )) ]; then fail="$fail memory"; fi
  if [ -n "$fail" ]; then echo "GATE FAILED:$fail"; exit 1; fi
  sleep 60
done
echo "MONITOR PASSED: $tick ticks over ${MINUTES} min"
exit 0
