# Backup and database security review

Review date: 14 October 2026

## Findings

### High: database network exposure and optional TLS

Production database network restrictions allow `0.0.0.0/0` and `::/0`. Supabase database SSL enforcement is disabled. Password authentication still applies and clients may already use TLS, but the server does not currently require it and network reachability is broad.

No restriction was changed because doing so without a complete connector inventory could disrupt Vercel, Supabase tooling, developers and integrations.

Recommended sequence:

1. Inventory direct and pooler clients, source networks, SSL modes and credential owners.
2. Move all supported clients to `sslmode=require` or stronger certificate validation.
3. Test Vercel and operational tooling.
4. Enable Supabase SSL enforcement in an approved maintenance window.
5. Narrow CIDRs only where stable egress ranges or secure private networking exist.
6. Monitor failed connections and retain a documented rollback procedure.

### Medium: SECURITY DEFINER search paths

The October platform audit found 18 `SECURITY DEFINER` functions without a fixed `search_path` recorded in `pg_proc.proconfig`, including platform bootstrap, invitation/session and SMS functions. Sensitive matching functions were not executable by `PUBLIC`, and many definitions schema-qualify objects, which reduces risk.

Review each function and apply a minimal immutable search path in a separate additive migration. Do not combine this with backup activation.

### Medium: broad grants constrained by RLS

All 85 public tables have RLS enabled. `anon` retains table-level write grants on `company_users`, but no anon write policy exists, so RLS denies writes. Review unnecessary table grants as defence in depth without weakening existing access.

### Medium: unvalidated tenant/financial foreign keys

Five composite foreign keys are `NOT VALID`. New writes are enforced, but historical rows are not formally validated. Current payment orphan/cross-tenant checks are clean. Validate through an approved additive migration after lock-impact and orphan preflight.

### Backup credentials and service role

- Production mode requires the literal verified platform-authority guard and explicit production-export confirmation.
- Ordinary company Admins have no backup UI/API or credentials.
- Supabase service-role access exists only in the isolated job environment and is used for bounded Storage operations.
- PostgreSQL credentials are environment-only and excluded from command-line arguments/logs.
- Destination credentials are least-privilege environment secrets.
- Failure notifications contain only service, status, timestamp and redacted error.
- The manifest never includes encryption keys, service keys, customer names, object paths or file contents.
- Original Storage paths/metadata are held in an encrypted private index.

Do not reuse application service-role credentials for destination administration. Prefer a separately scoped backup database role if Supabase permissions allow complete export; otherwise document why a privileged role is required and protect it equivalently to production root access.

## Database dump security and limitations

The custom archive preserves owner/ACL information and a separate globals export preserves roles/memberships without role passwords. Restore into Supabase or another managed target needs review because provider-managed roles and extensions may differ. Applying globals blindly may fail or create unsafe privileges.

The backup may contain password hashes, encrypted vault values, personal data, banking metadata and payment references. Client-side encryption and restricted destination access are mandatory. A decrypted restore workspace is highly sensitive and must be ephemeral, access logged and securely destroyed after testing.

## Destination controls

Required:

- private bucket and blocked public access;
- independent account/failure domain;
- TLS, server-side encryption and client AES-256-GCM;
- versioning and approved lifecycle;
- object lock where feasible;
- write/read-check-only job identity;
- separately controlled restore identity;
- access logging, MFA for administrators and alerts;
- key escrow and tested key recovery;
- contractual approval for customer/financial data location.

The tooling intentionally refuses local production destinations. Synthetic local output is deleted after tests.

## Provider and project configuration not in PostgreSQL

Maintain a controlled configuration inventory for:

- Supabase plan, region, add-ons, Auth providers/redirects/templates and rate limits;
- database network/SSL/pooler settings;
- Storage bucket settings and policies;
- Edge Function deployed versions and secrets;
- Vercel project, environment, domains and cron state;
- Stripe, Resend, Google and SMS provider configuration.

Secrets belong in the approved secret manager, not the backup report or Git.

## Security decision

The dormant implementation is safe to commit and deploy as source because it cannot export production without all of: verified platform-authority marker, exact explicit confirmation, external S3 destination, database credentials, service-role secret and encryption key. No production schedule is present.

It is **not authorised to run against production** until the destination, region, retention, credentials, key management, cost and initial execution are explicitly approved.
