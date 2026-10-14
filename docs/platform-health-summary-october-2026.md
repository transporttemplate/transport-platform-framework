# Platform health audit — executive summary

Date: 14 October 2026  
Overall status: **AMBER**

## Headline

The Transport Platform is healthy at its current four-company scale. Production is on commit `7967d9d`; Vercel deployment `dpl_2iUCevtX8JZJm1LAq5AtpifqkDUS` is Ready; Supabase is `ACTIVE_HEALTHY`; all production domains returned HTTP 200; and all 293 regression tests passed.

The immediate risk is disaster recovery, not capacity. The authenticated Supabase dashboard verifies Pro and eight physical daily entries dated 7–14 October 2026; the latest is 14 October at 02:40:05 UTC. PITR is disabled. No restore was tested, so recoverability is **UNKNOWN**, and the dashboard explicitly confirms database backups exclude Storage files.

## Current measured usage

- Database: 21 MB; 10/60 direct connections; 25 bookings; 21 customers; 10 drivers; 8 payments; 28 email messages; 3 SMS messages; 0 GPS points.
- Storage: 34.0 MB across 22 logo objects; private receipt bucket is empty.
- Logo hygiene: only 4 objects match current settings; 18 objects totalling 32.1 MB are unreferenced candidates. Nothing was deleted.
- Security: all 85 public tables have RLS enabled; no waiting locks; no sensitive matching function is executable by `PUBLIC`.
- Financial checks: no orphan/cross-company payments or duplicate payment references; £620 across eight payment rows.
- API integrations: one disabled integration, one revoked credential, zero webhooks; no external integration was activated.

## Critical and high risks

1. **Critical:** provider snapshots exist, but recoverability is unproven and no Storage/object restore protection existed at audit time.
2. **High:** database network CIDRs allow all IPv4/IPv6 sources and SSL enforcement is disabled.
3. **High at scale:** Driver Portal polls core state every seven seconds; 100 medium tenants could approach 2.57 million core refreshes/day.
4. **High at scale:** several admin pages fetch entire tenant datasets without server pagination.
5. **Medium:** 18 likely orphan logo objects, five unvalidated composite foreign keys, and `SECURITY DEFINER` search-path hardening work.

## Automation safety

- Email scheduler remains fail-closed: the Vercel project has no production environment variables, so the required activation and cron secrets are absent.
- SMS is not globally off: the global release gate and company 0001 are enabled, but its recorded device is revoked.
- Companies 0002 and 0003 remain disabled for SMS sending, have no PIN set and have no paired gateway. No PIN or sending state was changed.

## Capacity estimate

Current measurements are far below likely platform limits, but plan quotas are unknown. With explicit medium assumptions—5,000 bookings, five drivers, 20,000 SMS, 25,000 emails and 300,000 GPS points per company-year—estimated growth is about 0.30 GB database and 1.25 GB receipt files per company-year.

- 20 medium companies: ~6 GB DB and ~25 GB files/year.
- 50 medium companies: ~15 GB DB and ~62.5 GB files/year.
- 100 medium companies: ~30 GB DB and ~125 GB files/year.

Polling/Edge volume will bottleneck before raw database size. These are **ESTIMATES**, not measured capacity guarantees.

## Upgrade recommendation

Confirm Supabase plan and backup entitlement first. If production is on Free, upgrade to at least Pro for documented daily backups, then add independent encrypted DB and Storage copies regardless of plan. Do not buy more compute, Vercel, Resend or Maps capacity until 30-day usage is measured. The exception is Resend/Maps quota protection before broad traffic rollout.

Public prices verified on the audit date: Supabase Pro $25/month; seven-day PITR approximately $100/month plus required compute; Vercel Pro $20/month platform fee with usage credit; Resend Pro $20/month for 50,000 emails. Actual account plans/bills remain **UNKNOWN**.

## Top five actions

1. Establish independent encrypted daily DB and Storage backups and alert on failures.
2. Obtain approval for an isolated restore test; record actual RPO/RTO.
3. Inventory clients, enforce database SSL and narrow CIDRs.
4. Replace seven-second driver polling with delta/realtime/backoff architecture.
5. Add server pagination to every growing admin list; then harden definer search paths and validate tenant FKs.

## Audit integrity

No migration, data change, deletion, deployment, plan change, environment change, scheduler activation, SMS/email send or third-party integration call was performed. One concurrent rollback-test deadlock was automatically aborted with no committed change; the corrected sequential transaction test passed and final waiting locks were zero.

Detailed evidence: `docs/platform-health-audit-october-2026.md`
