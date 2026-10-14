# Independent backup and recovery plan

Release: 7.8.1  
Prepared: 14 October 2026  
Production Supabase project: `fewbszrvmvjiojijogra` (`eu-west-2`)

## Current protection before Release 7.8.1

The authenticated Supabase dashboard verifies that the organisation is on **Pro** and that scheduled physical database backups exist. The visible entries are:

- 14 October 2026 02:40:05 UTC (most recent)
- 13 October 2026 02:41:23 UTC
- 12 October 2026 02:42:11 UTC
- 11 October 2026 02:34:31 UTC
- 10 October 2026 03:36:20 UTC
- 9 October 2026 02:41:21 UTC
- 8 October 2026 02:42:10 UTC
- 7 October 2026 02:40:48 UTC

All visible entries are marked `PHYSICAL`; no failure is shown. Supabase states that Pro projects are backed up daily around midnight in the project region. The documented Pro entitlement is seven days of daily backup retention; the dashboard currently shows eight date entries across the inclusive window. Treat provider policy—not a momentary row count—as the retention contract.

Point-in-time recovery is available as a paid add-on but is **not enabled**. It was not enabled by this release. A listed provider backup has not been restored and is therefore not proven recoverable.

Measured production footprint:

- PostgreSQL database: 21,572,755 bytes (approximately 21 MB).
- Supabase Storage: 33,993,174 bytes across 22 objects.
- Storage buckets: public `company-logos`; private `driver-expense-receipts`.
- Network restrictions: `0.0.0.0/0` and `::/0`.
- Database SSL enforcement: disabled.

No current Supabase physical backup includes uploaded Storage object contents. It contains database metadata about those objects only.

## Independent backup design

Release 7.8.1 adds dormant tooling under `scripts/backup/` and a manual-only GitHub Actions workflow. It does not schedule or execute a production export.

### Database

The production runner:

1. Uses the official PostgreSQL `pg_dump` client against the direct database connection with `PGSSLMODE=require`.
2. Requests a custom-format, transactionally consistent export with `--serializable-deferrable`.
3. Preserves schema, data, ownership and ACL information in the custom archive.
4. Separately exports global roles/memberships through `pg_dumpall --globals-only --no-role-passwords`.
5. Streams command output directly through AES-256-GCM encryption. Plaintext is not written to the runner filesystem.
6. Records plaintext and ciphertext SHA-256 checksums, encrypted byte counts and artifact type in the manifest.

The database export is intended to contain accessible application schemas and data, including all companies and future tenants because it backs up the shared database rather than a hard-coded company list. It includes bookings, customers, drivers, vehicles, payments, earnings, expenses, recurring expenses, financial records, SMS, messages, audit records and API integration configuration to the extent the backup database role can read them.

Preflight must prove that the approved backup role can dump `public`, `auth`, `storage`, migrations, policies, functions and required extensions. If the provider prevents an object from being read, the job fails; it must not report a partial export as success.

### Storage

The runner:

1. Enumerates buckets through the Supabase Storage API using a service-role secret available only to the job.
2. Lists objects with bounded pages (default 100) and recursive prefixes.
3. Downloads with bounded concurrency (default two) and three exponential-backoff attempts.
4. Streams every object directly through AES-256-GCM encryption.
5. Stores encrypted objects under a hash-derived name, so external object keys do not disclose original paths.
6. Stores the original bucket, path, timestamps, size/MIME metadata, checksum and company/path association only inside an encrypted private index.
7. Places only counts, aggregate checksums and hashed paths in the plaintext manifest.

The design automatically discovers new buckets and future companies. It does not change bucket visibility or policies and never deletes objects.

### Encryption

- Algorithm: AES-256-GCM.
- Key: exactly 32 random bytes, supplied from an approved secret manager as base64 or hex.
- Nonce: a fresh 96-bit random IV per artifact.
- Authentication: GCM tag plus artifact-specific additional authenticated data containing the backup ID and logical artifact identity.
- Integrity: SHA-256 of plaintext and encrypted artifact, plus manifest aggregate checksum.
- Key material is never written to manifests, source, logs or destination paths.

Use a customer-controlled key-management system. Keep at least two recoverable, access-controlled copies of the key or wrapping key. Losing the key makes every independent backup unrecoverable. Key rotation should create new backups under the new key while retaining old keys for the corresponding retention window.

## External destination requirements

Production mode accepts only `BACKUP_DESTINATION=s3`. This means an approved S3 or compatible service accessed through the official AWS CLI; it does not mean AWS is pre-approved.

The destination must be outside the live Supabase project and should have:

- a dedicated private bucket and dedicated backup identity;
- server-side encryption in addition to client AES-256-GCM;
- versioning enabled;
- object-lock/immutability where available;
- public access blocked;
- TLS-only access;
- write/create and read-verification rights for the backup identity, without broad account administration;
- separate restore credentials held offline or behind approval;
- lifecycle retention of at least 30 days once policy is approved;
- access logging, spend alerts and failed-job notifications;
- a different failure domain and credentials from Supabase production.

The runner uploads every encrypted artifact with an SHA-256 request checksum and follows it with `head-object`. An uploaded manifest is the audit record. A future status panel may consume only the sanitised contract returned by `buildSystemHealthStatus`; it must never expose paths, contents or credentials.

## Automation policy

The repository contains `.github/workflows/independent-backup-manual.yml`. It has:

- `workflow_dispatch` only—there is no schedule;
- one non-overlapping concurrency group;
- a 60-minute timeout;
- a protected `production-backup` environment slot;
- secrets passed only from the environment;
- no repository write permission.

Recommended policy after explicit activation approval:

- daily database and Storage backup;
- weekly decrypt/checksum/manifest verification;
- minimum 30-day retention after legal/cost approval;
- alert if no verified manifest is newer than 30 hours;
- quarterly isolated recovery exercise.

Do not add a cron trigger until the initial real backup has uploaded, been verified, costs reviewed and the operator explicitly authorises recurring execution.

## What is not fully covered by the database archive

| Dependency | Protection / required separate action |
|---|---|
| Supabase Auth users and Auth tables | Expected in DB dump if role access permits; verify table counts. Auth provider configuration, email templates and OAuth settings require a separate configuration record. Password hashes must remain encrypted and access restricted. |
| Uploaded Storage objects | Covered only by the independent Storage pass, not `pg_dump` or Supabase physical backups. |
| Storage bucket policies/metadata | Database schema/metadata plus encrypted object index; verify after restore. |
| Edge Function code | Source is in Git at a recorded commit; deployed versions are listed in operational records. |
| Edge Function secrets | Not exported. Recreate from an approved secret manager. Never include in backup manifests. |
| Supabase project configuration | Record region, Auth settings, network/SSL, custom domains and add-ons separately; not all are PostgreSQL objects. |
| Vercel configuration/secrets | Source is in Git; environment and domain settings require separate controlled records. |
| Stripe, Resend, Google, SMS credentials | Not exported as plaintext. Reissue/reconfigure through each provider. |
| Supabase provider physical backup | Separate provider control; not copied by this tooling. |

## Capacity and estimated cost

At the current footprint, a full uncompressed daily copy is approximately 55 MB before encryption/compression effects (21 MB database plus 34 MB files). Thirty full daily generations would be about 1.65 GB, plus manifests, role data, versioning and provider overhead. Actual custom-format database compression may reduce this; retained superseded versions may increase it.

At medium growth from the October 2026 audit, 20 companies could generate about 6 GB database and 25 GB file data per year. A naive 30-copy full Storage strategy would be wasteful; use versioned incremental/object-deduplicated retention before that scale.

Indicative S3 Standard storage at public list pricing is only a few US cents per GB-month, so the current raw storage component should normally be under $1/month. Requests, versioning, object lock, minimum storage duration, egress, KMS, alerting and CI minutes are provider-specific and **UNKNOWN** until a destination/account is selected. Supabase Pro and optional PITR are separate costs. No service was purchased.

## Current operational truth

- Real independent production database backup exists: **NO**.
- Production Storage objects backed up independently: **NO**.
- Real production backup restored successfully in isolation: **NO**.
- Automatic independent backups enabled: **NO**.
- Synthetic encryption/manifest/recovery validation: **YES**, with the limitations in `docs/backup-test-results.md`.
