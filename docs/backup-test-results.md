# Release 7.8.1 backup test results

Test date: 14 October 2026

## Automated tests

The new suite covers:

- AES-256-GCM encrypt/decrypt and tamper detection;
- 32-byte key validation;
- manifest generation and validation;
- missing/stale backup detection;
- bounded paginated recursive Storage enumeration;
- transient failed-download retries;
- duplicate-job locking;
- platform-authority enforcement and ordinary Admin denial;
- S3 destination configuration/authentication boundary;
- post-upload object existence verification;
- failure-notification redaction;
- sanitised future System Health status;
- synthetic schema, relationship, RLS-policy and Storage recovery evidence;
- incomplete/truncated restore detection.

Targeted backup tests: **14 passed, 0 failed**.  
Full repository suite: **307 passed, 0 failed**.

## Synthetic recovery exercise

The test creates only synthetic data:

- one synthetic company;
- one related synthetic booking;
- role, table, foreign-key, RLS enablement and policy statements;
- one private synthetic Storage object and metadata index.

It encrypts each artifact with AES-256-GCM, writes a non-sensitive manifest, decrypts to a disposable temporary directory, validates required schema/relationship/RLS statements, restores the synthetic object path and verifies its SHA-256. The temporary directory is deleted.

Measured final synthetic restore duration: **2.56 ms**. This fixture-scale result is not a platform RTO.

## Important limitations

- No production database or Storage object was exported.
- No real independent production backup exists.
- No real Supabase physical or independent backup was restored.
- PostgreSQL client binaries and Docker were unavailable on the audit workstation. The synthetic SQL was structurally validated but not executed by a PostgreSQL engine.
- Auth users/configuration, managed roles/extensions, Edge secrets, Vercel, Stripe, Resend, Google and SMS dependencies were not restored.
- S3 calls were mocked for tests; no customer data was sent externally.
- Failure notifications were mocked; no real notification was sent.
- Production RPO and RTO remain unverified.

## Required next recovery test

After a destination and initial export are explicitly approved:

1. provision an authorised disposable local PostgreSQL 17 environment (not a new Supabase project);
2. download one encrypted backup into an ephemeral isolated runner;
3. recover the encryption key through the approved process;
4. decrypt and inspect roles/custom archive;
5. restore into local PostgreSQL;
6. restore files into an isolated filesystem or approved test object store;
7. compare table/object counts, schemas, grants, RLS, tenant isolation and financial totals;
8. record actual duration and failures;
9. destroy the decrypted workspace securely.

This requires separate approval because it uses a real production-data backup.

## Commands

```sh
# Safe synthetic validation with a temporary generated test key
BACKUP_ENCRYPTION_KEY='<base64 32-byte test key>' npm run backup:synthetic

# Full non-destructive repository suite
npm test
```

The production command must not be run until every manual control in `docs/backup-operations-runbook.md` is satisfied.
