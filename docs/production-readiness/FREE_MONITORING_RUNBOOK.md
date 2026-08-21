# Free Monitoring Runbook

Use only the existing GitHub Actions health workflow, Railway dashboard/CLI, Supabase dashboard/logs, and YSD's existing internal telemetry. Do not add paid alerts, credits, or services. The repository workflow runs the public health check every 15 minutes and also supports manual dispatch; its result is evidence, not a guarantee that an external notification was delivered.

## Checklist

| Surface | Manual checks | Escalation trigger |
| --- | --- | --- |
| GitHub Actions | `production-health.yml` schedule/dispatch status and the redacted health artifact | missed/failed checks, unexpected URL, or non-200 health response |
| Railway | deployment SHA/status, instance health, health endpoint, 5xx count/pattern, application error logs | wrong SHA, failed/restarting instance, sustained 5xx, repeated uncaught errors |
| Supabase | database health, connection pressure, Auth failures, Security Advisor delta, DB error/slow-query logs | degraded health, connection exhaustion, unexplained Auth spike, new ERROR security finding, repeated DB errors |
| YSD Assistant | request count, p50/p95 latency, SSE disconnects, Device Auth failures, HTTP 429s, provider failures, quota rejections | error/429/provider failures above the approved pilot threshold, sustained latency regression, repeated token/device failures |

## Cadence for a future limited pilot

- Before enablement: record deployment SHA, variables fingerprint, migration list/count, user count, provider/model state, kill-switch state, and a zero-traffic baseline.
- First hour: operator checks every 10 minutes (0, 10, 20, 30, 40, 50, and 60 minutes).
- Remainder of first day: check hourly.
- Continuing pilot: check daily and after every deployment/configuration change.

The operator records timestamp, source, values/counts, anomalies, and action in the pilot log. A second reviewer validates the first-hour and end-of-day entries.

## Response

1. On an Assistant-specific threshold breach, disable the feature with the pre-approved kill-switch procedure; do not mutate unrelated Auth, SMTP, provider, or DB settings.
2. Preserve deployment SHA, request/correlation IDs, timestamps, and a redacted log excerpt. Never record tokens, credentials, prompt contents, or private page data.
3. Classify the fault as deployment, database/Auth, provider/quota, Device Auth, SSE/network, or client.
4. Escalate to the release owner and security owner for any wrong SHA, privilege anomaly, token leak, cross-user data indication, or persistent 5xx.
5. Re-enable only after a reviewed corrective candidate passes the same regression gate.
