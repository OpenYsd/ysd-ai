# Railway Production Branch Transition Plan

This is a preparation-only plan. Do not change Railway source settings outside an approved Production window.

The previously approved deployment was `cc076481-2576-4cd9-a1f1-9387a7f93d0b`. Read-only verification during Sprint 2 detected that Railway had already moved externally to deployment `42cbcc90-5c10-4cde-ae28-d309c836e10e`, commit `fecc9d4df699114cc4cdef02f6ac4d4a699db3c6`, while the source branch remains named `staging`. Sprint 2 did not trigger or modify that deployment.

## Controlled zero-downtime sequence

1. Freeze deploys and identify the actually approved deployed commit and image digest. Resolve the current external drift before treating either SHA as the promotion baseline.
2. Create a protected `release/production` branch at exactly the approved immutable candidate commit. Require reviews and disable force pushes.
3. Verify zero source difference with `git diff --exit-code <approved-sha>..<release/production>` and record both tree hashes. A branch-name-only transition must produce no code diff.
4. Confirm the Browser Assistant kill switch remains disabled and record the current environment-variable fingerprint without values.
5. During the approved window only, change the Railway source branch to `release/production` and initiate the controlled deployment.
6. Verify that Railway reports the exact approved Git SHA, healthy instance state, successful health endpoint, expected application logs, and the unchanged variables fingerprint.
7. If the SHA/tree, health, or logs differ, stop the rollout and restore the previously recorded immutable deployment/source. Do not debug by editing Production variables or database state during the rollback.

Ownership: release operator performs the switch; a second reviewer verifies SHA/tree and the health checklist. The current branch-name issue is operational metadata, not authorization to deploy.
