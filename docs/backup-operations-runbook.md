# Backup operations and disaster-recovery runbook

This runbook is for verified platform-level operators. Ordinary company Owners/Admins must not receive backup credentials or cross-tenant archives.

## 1. One-time destination setup

1. Select and contractually approve an external S3-compatible destination outside the live Supabase project.
2. Create a dedicated private bucket in an approved region.
3. Block public access, require TLS, enable server-side encryption, versioning and access logging.
4. Enable object lock/immutability if the provider and retention policy permit it.
5. Create a least-privilege backup identity scoped to the backup prefix. Create a separately approved restore identity.
6. Configure a 30-day minimum lifecycle only after legal/accounting approval. Preserve any required longer financial retention separately.
7. Create a 32-byte random client encryption key in an approved KMS/secret manager. Configure recoverable escrow; do not download it into the repository.
8. In GitHub, create the `production-backup` Environment, require an authorised reviewer and prevent self-approval where supported.
9. Add the names from `scripts/backup/env.example` as Environment secrets. Never paste values into workflow/source files.
10. Allow the runner’s database egress path without narrowing current production CIDRs in this release.
11. Use a direct Supabase database endpoint for `pg_dump`, not a transaction pooler. Set `PGSSLMODE=require`.
12. Verify the installed `pg_dump` major version is compatible with PostgreSQL 17.

Required secrets:

- destination bucket/region/endpoint and least-privilege access credentials;
- `BACKUP_ENCRYPTION_KEY`;
- direct database host, port, database, approved backup user and password;
- Supabase URL and service-role key for Storage enumeration/download;
- optional failure-notification webhook containing no customer data.

## 2. Initial production backup—requires explicit approval

Do not perform these steps until the operator approves exporting production data to the named destination.

1. Confirm the destination, data-processing terms, region, retention and estimated cost in writing.
2. Confirm the encryption key can be recovered by two authorised operators.
3. Confirm the GitHub Environment reviewer and secret scopes.
4. Run the manual workflow “Independent production backup (manual approval only)”. Approval of the protected Environment is the final execution gate.
5. Monitor only sanitised status. Do not print database/Storage content or secrets.
6. Require a successful manifest with:
   - database and role artifacts;
   - expected Storage object count;
   - encrypted byte counts;
   - SHA-256 checksums;
   - `verified_before_upload` state;
   - successful destination `head-object` checks.
7. Compare production counts using read-only aggregate queries: companies, public/auth/storage tables, bookings, customers, drivers, payments, financial documents, SMS, messages and audits.
8. Record the backup ID and destination version IDs in the restricted operations log.
9. Run an approved decrypt/integrity check in an isolated runner.
10. Only after success, cost review and explicit recurring-activation approval may a daily cron be proposed.

Local direct command for an authorised hardened runner:

```sh
npm ci
npm run backup:production
```

All configuration must arrive through its secret manager/environment. Do not use command-line flags containing passwords.

## 3. Daily operations after future activation

- Confirm no overlapping job; the runner also uses an exclusive lock and CI concurrency.
- Confirm last verified manifest age is under 30 hours.
- Review object counts and encrypted sizes for unexpected drops/spikes.
- Investigate any missing bucket, partial download, retry exhaustion, dump failure or destination authentication failure.
- Never mark a failed or incomplete job successful manually.
- Weekly, select one retained generation, decrypt into an isolated workspace, re-hash all artifacts and validate the manifest.
- Monthly, verify secret/KMS access, bucket versioning/object lock, lifecycle policy, alerts and restore tooling.
- Quarterly, perform an approved isolated PostgreSQL and Storage restore exercise.

## 4. Selective incident procedures

### Accidental booking deletion

1. Stop related administrative writes if ongoing.
2. Preserve audit logs and identify booking/company/time/financial dependencies.
3. Do **not** restore the whole production database for one row.
4. Restore the relevant backup into an isolated PostgreSQL environment.
5. Extract the booking and every dependent record into a reviewed recovery package.
6. Validate tenant, payment, receipt/invoice, return journey, SMS/email, calendar and audit references.
7. Obtain business and security approval for any production reinsert/update.
8. Apply through a purpose-built transaction and record a recovery audit.

This selective method has not been tested against a real production backup and must not be promised until exercised.

### Storage object loss

1. Identify bucket/path/version and company authority.
2. Retrieve the encrypted generation and private index in an isolated runner.
3. Decrypt and verify SHA-256.
4. Confirm MIME type, size, tenant path and legal status.
5. Obtain approval before uploading to production. Never make a private bucket public.

### Failed migration or database corruption

1. Stop deployments and high-risk writes.
2. Capture logs, migration identifier, time and affected records.
3. Prefer a reviewed forward repair if integrity is understood.
4. For restore, build an isolated PostgreSQL 17 target and restore there first.
5. Compare schemas, row counts, RLS, grants and financial aggregates.
6. Production restore requires a separate outage/change plan and explicit approval.

### Compromised API/service credentials

1. Revoke the affected credential at its authoritative provider.
2. Review API request, webhook, platform-security and provider audit logs.
3. Do not restore compromised credentials from backup.
4. Rotate through the existing protected procedure and update the secret manager.
5. Verify ordinary tenants remain isolated.

### Supabase outage or loss of project access

1. Confirm provider status and account authority through trusted channels.
2. Preserve the latest independent manifest and Git commit.
3. Do not create a replacement Supabase project without explicit approval.
4. Prepare schema/roles, Auth configuration, Storage, functions and secrets for an approved replacement environment.
5. Restore and validate locally/isolated before DNS or Vercel changes.

## 5. Full platform recovery order

1. Establish an authorised isolated PostgreSQL 17 target.
2. Decrypt `roles.sql.enc`; review managed/provider roles before applying.
3. Apply compatible roles/memberships. Never overwrite provider-managed credentials blindly.
4. Decrypt the custom database archive.
5. Inspect with `pg_restore --list`.
6. Restore schema/data/ACLs into the isolated target. If provider-managed owners differ, use a reviewed `--no-owner` restore and apply required grants explicitly.
7. Validate extensions, functions, triggers, RLS policies, grants, Auth/Storage metadata and migration history.
8. Decrypt the Storage private index and objects; verify every checksum before upload to an isolated Storage target.
9. Restore Edge Functions from the recorded Git commit and redeploy only after code review.
10. Recreate secrets from the secret manager: Supabase, Stripe, Resend, Google Calendar/Maps, SMS gateway and backup credentials.
11. Recreate Vercel environment, functions, domains and cron state. Keep SMS/email schedulers disabled until separately authorised.
12. Reconcile all companies, bookings, customers, drivers, payments, receipts/invoices, earnings/expenses, communications and audits.
13. Perform security and regression tests.
14. Obtain incident commander, business owner and security approval before traffic cutover.

Example isolated commands after decrypting artifacts:

```sh
createdb transport_platform_restore
psql transport_platform_restore --file roles-reviewed.sql
pg_restore --exit-on-error --clean --if-exists --dbname transport_platform_restore database.dump
```

Never point these commands at production during a test.

## 6. Recovery objectives

- Current provider daily backup theoretical RPO: up to about 24 hours; not restore-tested.
- Proposed daily independent backup target RPO: 24 hours.
- Proposed initial RTO: 4–8 hours for database plus Storage at current size.
- Synthetic logical fixture recovery measured by Release 7.8.1: see `docs/backup-test-results.md`.
- Actual production RTO/RPO: **UNKNOWN** until an isolated real-backup restore is approved and measured.

## 7. Recovery dependency checklist

- Supabase account/organisation authority and project configuration
- PostgreSQL 17 and compatible extensions
- Auth provider settings, redirect URLs, templates and SMTP
- encrypted DB/roles artifacts and recoverable key
- encrypted Storage index/objects and destination access
- Edge Function Git commit and deployment inventory
- Edge Function/Vercel secrets
- Vercel project, domains and DNS
- Stripe webhooks/keys
- Resend domains/webhooks/keys
- Google Calendar ownership/credentials
- Google Maps restrictions/billing
- Android SMS devices, device credentials and disabled/enabled gates
- API integration/webhook credential revocation state
- audit and financial reconciliation sign-off
