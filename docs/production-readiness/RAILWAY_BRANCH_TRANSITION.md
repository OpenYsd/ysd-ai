# Railway Production Branch Transition Plan

This is a preparation-only plan. Phase 0 creates and protects Git refs but does not change Railway source settings, deploy, restart, or apply database migrations.

The current observed Production deployment is `5fd1db33-b220-46c3-a21f-e7bdbb43c2cb` at commit `6bfd511f7367e213edc379df722cbc82519c95b9`, image `sha256:c8001588b73a34c4fa088b85501a4209eb4e30413afa92b60029fc9b4c7afdac`. It was triggered after auto-deploy was re-enabled outside the controlled path. Auto-deploy has been disabled again. The Railway source branch remains named `staging`, but Phase 0 does not alter that branch or connection.

The exact current-runtime baseline is preserved separately as `release/production-baseline-6bfd511`. The readiness candidate must be rebuilt from that commit so monitoring, recovery, storage reconciliation, and restore-drill work cannot be lost.

## Controlled zero-downtime sequence

1. Keep Railway Production auto-deploy disabled and record deployment, commit, image digest, health, variables fingerprint, migration count, and user count without secret values.
2. Verify the exact `6bfd511` baseline and the rebuilt readiness candidate from clean worktrees.
3. Create a protected `release/production` branch at exactly the approved immutable candidate commit. Require pull-request review and disable force pushes and deletion.
4. Verify zero source difference with `git diff --exit-code <approved-sha>..<release/production>` and record both tree hashes. A branch-name-only transition must produce no code diff.
5. Set `YSD_BROWSER_ASSISTANT_ENABLED=0` with deployment explicitly skipped. Missing Browser token/config remains fail-closed; no secret is generated during Phase 0.
6. Stop Phase 0. Do not switch Railway source, deploy, restart, enable Assistant, apply migrations, configure Browser secrets, or publish Browser.
7. During a later separately approved deployment window only, change the Railway source branch to `release/production` and initiate the controlled deployment while the Assistant stays disabled.
8. Verify that Railway reports the exact approved Git SHA, healthy instance state, successful health endpoint, expected application logs, and the pre-recorded variables fingerprint.
9. If the SHA/tree, health, or logs differ, stop the rollout and restore the previously recorded immutable deployment/source. Do not debug by editing unrelated Production variables or database state during rollback.

Ownership: release operator performs the later switch; a second reviewer verifies SHA/tree and the health checklist. Phase 0 branch preparation is not authorization to deploy.
