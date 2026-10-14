# Transport Platform health, performance, storage and backup audit

Audit date: 14 October 2026  
Production commit: `7967d9da41929e8a233e75df4a08d5ecf00d39df`  
Vercel deployment: `dpl_2iUCevtX8JZJm1LAq5AtpifqkDUS` (`READY`)  
Supabase project: `fewbszrvmvjiojijogra`, London (`eu-west-2`), `ACTIVE_HEALTHY`

## Status vocabulary

- **VERIFIED**: measured from production, repository configuration, a supported provider interface, or a completed test during this audit.
- **ESTIMATED**: a stated projection based on explicit workload assumptions; it is not measured usage.
- **UNKNOWN**: the relevant account-level metric, plan, bill, or recovery evidence was not available through the accessible interfaces.

## Executive assessment

**Overall health: AMBER.** The live application, database, domains, tenant controls and current record integrity are healthy at the present very small workload. All 293 repository regression tests passed. The database is only 21 MB, Storage is approximately 34 MB, connections are 10 of 60, all 85 public tables have RLS enabled, and no waiting lock was present at the end of the audit.

The principal risk is disaster recovery. The supported CLI reports WAL-G enabled, PITR disabled and no available backup entries. A restore was not attempted, so recoverability is **UNKNOWN**. Supabase Storage needs a separate protection strategy. Secondary risks are unrestricted database network CIDRs with SSL enforcement disabled, polling-heavy driver traffic that will become the first scaling bottleneck, 18 likely unreferenced logo objects occupying 32.1 MB, unvalidated composite foreign keys, and several `SECURITY DEFINER` functions without a fixed recorded `search_path` setting.

No migration, production record change, deployment, environment change, plan change, scheduler activation, SMS activation, email/SMS send, Storage deletion, booking creation, or third-party integration call (CMAC, Pulse or dispatch partner) was performed.

## Scope and method

The audit used:

- read-only Supabase Management API and SQL catalogue/statistics queries;
- Supabase CLI project, function and backup listings;
- read-only Vercel CLI project, deployment, build, domain, environment-name and log inspection;
- one lightweight HTTP request per production domain;
- desktop and 390 × 844 responsive browser inspection, Chrome performance metrics and console inspection;
- repository searches for polling, subscriptions, query bounds, Storage access, schedulers, secrets and fail-closed gates;
- the full local test suite and transaction-rolled-back production security tests.

No high-load stress test was performed. Historical provider billing and detailed CPU/RAM time series were not accessible.

## 1. Current infrastructure

### Supabase

| Item | Finding | Status |
|---|---:|---|
| Project status | `ACTIVE_HEALTHY` | VERIFIED |
| Region | `eu-west-2` | VERIFIED |
| PostgreSQL | 17.6 / aarch64 | VERIFIED |
| Database size | 21,572,755 bytes (21 MB) | VERIFIED |
| Direct connection ceiling | 60 | VERIFIED |
| Current connections | 10: 7 idle, 1 active, 2 internal/unknown | VERIFIED |
| PITR | Disabled; paid add-on available | VERIFIED |
| WAL-G | Enabled | VERIFIED |
| Project plan | Pro, verified in authenticated dashboard | VERIFIED |
| Compute tier | Not exposed by accessible API/CLI | UNKNOWN |
| Allocated disk / free disk | Not exposed by accessible API/CLI | UNKNOWN |
| CPU / RAM time series | Not exposed by accessible API/CLI | UNKNOWN |
| Pooler size and utilisation | Not exposed by accessible API/CLI | UNKNOWN |

The 60 direct-connection ceiling matches Supabase Micro specifications, but that does not prove whether the organisation is Free or paid; plan is therefore not inferred.

### Vercel

| Item | Finding | Status |
|---|---:|---|
| Project | `transport-platform-framework` | VERIFIED |
| Latest production | commit `7967d9d`, deployment `dpl_2iUCevtX8JZJm1LAq5AtpifqkDUS` | VERIFIED |
| Deployment state | Ready | VERIFIED |
| Build | 6 s build, 9 s post-build, 1 billable minute, 4 CPU-minutes | VERIFIED |
| Build machine | 4 vCPU / 8 GB assigned | VERIFIED |
| Functions | `/api/email-dispatcher-cron` 2.39 KB; `/api/v1/[resource]` 1.69 KB, region `iad1` | VERIFIED |
| Recent deployment runtime logs | 0 records in accessible one-hour window | VERIFIED |
| Account plan and bill | Not exposed by accessible CLI | UNKNOWN |
| Bandwidth, invocation and cache totals | Not exposed by accessible CLI | UNKNOWN |

### Production domains

All returned HTTP 200 and were attached to the current production deployment:

- `www.etbm.co.uk` and `etbm.co.uk`
- `www.jeffscars.com` and `jeffscars.com`
- `www.carmarthencabs.com` and `carmarthencabs.com`
- `transport-platform-framework.vercel.app`

Single lightweight samples were 2.379 s, 0.091 s, 0.386 s and 0.134 s total respectively. These are observations, not statistically meaningful latency percentiles. Static HTML showed Vercel cache `HIT` for ETBM and `MISS` for the sampled Driver Portal response.

## 2. Database health and usage

### Rows and relation sizes

Key production counts:

| Relation | Rows | Total relation size |
|---|---:|---:|
| bookings | 25 | 304 KiB |
| customers | 21 | 80 KiB |
| drivers | 10 | 136 KiB |
| payments | 8 | 80 KiB |
| receipts | 13 | 96 KiB |
| invoices | 3 | 128 KiB |
| email_messages | 28 | 152 KiB |
| email_deliveries | 67 | 136 KiB |
| sms_messages | 3 | 80 KiB |
| sms_templates | 52 | 96 KiB |
| sms_automation_rules | 60 | 88 KiB |
| driver_sessions | 56 | 112 KiB |
| driver_gps_points | 0 | 32 KiB |
| api_integrations | 1 | 32 KiB |
| api_credentials | 1 | 40 KiB |
| outbound webhooks / deliveries | 0 / 0 | 16 KiB / 32 KiB |

The one integration was disabled, its one credential was revoked, and there were no webhooks. It was observed but not created, activated, rotated or otherwise changed during this audit.

The booking dataset spans 7–12 October 2026 and is too young and too small to establish a reliable growth trend. Provider usage history was inaccessible; growth trend is **UNKNOWN**.

### Database activity

- **VERIFIED:** 3,150,125 committed and 1,794 rolled-back transactions at the initial sample.
- **VERIFIED:** cache hit ratio was approximately 99.997% (`82,896,047` hits, `2,719` reads).
- **VERIFIED:** no waiting lock and no transaction older than five minutes at final inspection.
- **VERIFIED:** the configured statement timeout is two minutes; idle-in-transaction timeout is `0` (disabled).
- **VERIFIED:** cumulative temporary data was approximately 158.3 GB. This is disproportionate to the 21 MB database.
- **VERIFIED:** the largest cumulative statements were provider/schema introspection and timezone catalogue queries. Application RPCs visible in the top group were short on average, although some maxima exceeded 100 ms.
- **VERIFIED:** a schema-introspection statement wrote 353,918 temporary blocks. This plausibly explains a material part of cumulative temporary I/O, but causation is an inference.

Sequential scans are high on tiny catalogue/configuration tables (`drivers`, `settings`, `driver_sessions`, `airports`, `service_areas`). At current row counts this is not a performance fault. Reassess with real volume and `EXPLAIN (ANALYZE, BUFFERS)` in staging before adding indexes.

### Vacuum, bloat and indexes

Autovacuum/autoanalyse is running on active tables such as `bookings`, `drivers`, `email_messages`, `sms_templates` and `sms_automation_rules`. Some small tables have never required an observed autovacuum. Dead rows are high as a percentage on several tiny relations but are only tens of tuples, not meaningful bloat at present.

The schema contains 54 explicitly created indexes plus primary/unique indexes. Important production paths have company-scoped indexes, including booking references, source/idempotency keys, email/SMS queues, GPS playback, payments by paid date and webhook queues. There is no evidence-based missing-index emergency at current scale.

### Lock-test disclosure

One deadlock occurred during this audit when two migration-backed rollback tests were mistakenly launched concurrently. PostgreSQL aborted the affected transaction; no changes committed. The test was replaced with a transaction-only check against existing production functions and then passed. Final waiting locks: zero. The database deadlock counter is now one and should not be interpreted as an application deadlock without this context.

## 3. Financial data integrity and retention

- **VERIFIED:** `payments.amount` is `numeric(10,2)`; booking fares also use decimal numeric fields.
- **VERIFIED:** 8 payment rows total £620; no orphan payment, cross-company payment or duplicate non-null payment reference was found.
- **VERIFIED:** booking aggregate gross is £2,126.50, `amount_paid` is £620, and recorded balance due is £790. These are separate semantics and are not expected to arithmetically reconcile across every booking state.
- **VERIFIED:** payment, receipt, invoice, statement and expense tables have RLS and financial constraints. Receipts have company+booking foreign keys and per-company uniqueness.
- **VERIFIED:** permanent deletion tests preserve financial blockers, return protections and reauthentication logic; no booking was deleted.
- **VERIFIED:** five composite foreign keys remain `NOT VALID`: booking driver/company, invoice/company, vehicle/company, and two email-delivery financial-document links. `NOT VALID` still checks new writes but does not prove all historic rows.
- **VERIFIED:** current cross-tenant payment consistency is clean. Composite booking financial links should be validated in a reviewed maintenance release after read-only orphan checks.
- **UNKNOWN:** legal retention policy, accounting export cadence and an independently verified recovery copy. These require an approved policy decision, not code inference.

Recommended retention design: never use operational cleanup to remove statutory invoices, receipts, payment ledgers, finalised driver statements or their audit trail. Define UK accounting retention with the organisation’s accountant/legal adviser; archive operational payloads separately from immutable financial evidence. Exports should be encrypted, access logged, tenant labelled and restore-tested.

## 4. Supabase Storage

| Bucket | Public | Objects | Bytes | Limit / types | Status |
|---|---:|---:|---:|---|---|
| `company-logos` | yes | 22 | 33,993,174 | 5 MB; PNG/JPEG/WebP/GIF | VERIFIED |
| `driver-expense-receipts` | no | 0 | 0 | 3 MB; JPEG/PNG/WebP/PDF | VERIFIED |

The logo bucket has public read and authenticated company-scoped insert/update/delete policies. All paths begin with a valid company UUID. Only four logo objects are referenced by current company settings; **18 objects totalling 32,135,429 bytes are unreferenced candidates**. No object was deleted. Confirm reference rules and backup before any cleanup.

Expense receipts are written only by the service-role Driver Portal function into tenant/driver/expense paths. The private bucket has no browser policies, so ordinary clients cannot enumerate it. This is an appropriate fail-closed design.

Database backups should not be assumed to include Storage objects. An independent Storage inventory and encrypted object copy is required.

## 5. Backups and disaster recovery

### Measured state

- **VERIFIED:** CLI reports `walg_enabled: true`.
- **VERIFIED:** CLI reports `pitr_enabled: false`.
- **VERIFIED:** the CLI returned an empty available-backups list, but the authenticated dashboard showed eight physical daily entries dated 7–14 October 2026. The CLI result was therefore incomplete for this project.
- **VERIFIED:** most recent displayed physical backup: 14 October 2026 02:40:05 UTC; no displayed entry showed a failure.
- **UNKNOWN:** database recoverability; no restore has been performed.
- **UNKNOWN:** Storage object recoverability; no independent copy or restore evidence was found.

This remains the audit’s only **critical** risk because listed physical backups have not been restored and Storage objects are explicitly excluded. Provider status and WAL activity are not restore evidence.

### Recommended recovery architecture

1. Confirm the Supabase organisation plan and the Backups dashboard immediately. If production is Free, move to Pro before relying on provider recovery. Supabase documents daily backups with seven-day retention on Pro; Free does not include automatic backups.
2. Add a daily encrypted logical database export to a separate provider/account with immutable retention: 7 daily, 5 weekly and 12 monthly copies as an initial policy, subject to legal approval.
3. Add daily Storage object inventory and incremental encrypted copies to a separate bucket/account. Include checksums, object metadata and deletion protection.
4. Store run manifests and alert on missed/partial backups. Credentials must be narrow, rotated and outside Git/logs.
5. After explicit approval, test restoration into an isolated non-production Supabase project or local environment. Reconcile table counts, tenants, Auth mappings, functions, RLS, financial totals and sampled files. Never overwrite production for a test.
6. Repeat quarterly and after material schema/storage changes.

Proposed service targets:

- Daily independent copies only: target RPO 24 hours, target RTO 4–8 hours.
- Provider PITR plus independent copies: target RPO under 15 minutes, target RTO under 4 hours, subject to a measured restore exercise.

These remain targets, not achieved guarantees.

## 6. Edge Functions, queues and automation

Eighteen deployed Edge Functions were **ACTIVE**:

| Function | Version | JWT flag |
|---|---:|---:|
| google-calendar-sync | 34 | false; function performs its own service/admin checks |
| driver-portal | 40 | true |
| public-booking-create | 51 | false; public endpoint with server validation/rate limits |
| stripe-webhook | 26 | false; signed webhook |
| send-booking-email | 25 | true |
| unallocated-booking-reminders | 18 | true |
| send-invoice-email | 20 | true |
| send-driver-statement-email | 19 | true |
| send-receipt-email | 7 | true |
| customer-portal | 7 | true |
| email-usage | 7 | true |
| email-dispatcher | 9 | false; secret and activation gates |
| resend-webhook | 7 | false; signed webhook |
| empty-legs | 7 | false; action-specific auth/rate limits |
| sms-gateway | 3 | false; device credential and release gates |
| api-v1 | 4 | false; API credential or platform-session checks |
| webhook-dispatcher | 1 | false; dispatcher secret |
| staff-management | 2 | true |

**UNKNOWN:** provider invocation count, error rate, p50/p95 duration, memory and timeout totals. They were not exposed through the accessible CLI/API. The repository implements bounded claims, retries, idempotency and sanitised failure recording for email, SMS and outbound webhooks. There is no explicit dead-letter queue; terminal failed rows remain in their queue/history tables for review.

### Gates

- **VERIFIED:** there is no `pg_cron` extension/job.
- **VERIFIED:** the Vercel project exposes no production environment variables. Therefore `EMAIL_AUTOMATION_ENABLED`, `EMAIL_AUTOMATION_NOT_BEFORE` and `CRON_SECRET` are absent and the email cron route fails closed. No scheduler was activated.
- **VERIFIED:** SMS is **not globally disabled**: `sms_release_control.live_sending_enabled=true`, and company 0001 settings are enabled. Its only recorded device is revoked.
- **VERIFIED:** companies 0002, 0003 and 0004 have both SMS `enabled=false` and `sending_enabled=false`; none has a gateway PIN set and none has a paired device. No PIN was created/reset and no SMS gate changed.

The distinction matters: Release 7.8 preserved state, but production does not satisfy a blanket statement that every SMS gate is globally off.

## 7. Security and tenant isolation

### Positive evidence

- **VERIFIED:** all 85 public tables have RLS enabled; 71 public policies exist.
- **VERIFIED:** no sensitive function matching deletion/bootstrap/banking/credential/payment/owner/staff was executable by `PUBLIC`.
- **VERIFIED:** API credentials are represented by hashed credential records; the one observed credential is revoked.
- **VERIFIED:** API integrations, webhooks, SMS settings/devices, GPS, banking and finance are company scoped or service-only in migrations/functions.
- **VERIFIED:** transaction-rolled-back tests passed for owner grant/revoke, ordinary staff denial, cross-company denial and audit generation. Release 7.7 bootstrap/preset/override/isolation rollback checks also passed.
- **VERIFIED:** 293/293 repository tests passed, including anonymous denial, tenant isolation, payment integrity, API scopes/rate limits, webhook signatures/retries/deduplication, mobile auth boundaries and secure deletion.

### Findings

1. **High — network and transport posture.** Database allowed CIDRs are `0.0.0.0/0` and `::/0`; database SSL enforcement is disabled. Authentication still applies, but exposure is broader than necessary. Inventory every legitimate connector, then enable SSL enforcement and narrow network access in a reviewed maintenance window.
2. **Medium — definer search path.** Eighteen `SECURITY DEFINER` functions do not expose a fixed `search_path` setting in `pg_proc.proconfig`, including bootstrap, staff invitation, session revocation, outbound event capture and SMS functions. Many schema-qualify objects and are not publicly executable, reducing exploitability. Review each definition and set an explicit minimal search path in an additive migration.
3. **Medium — broad grants constrained by RLS.** `anon` has table-level write grants on `company_users`, but no anon write policy; RLS denies access. This is fail-closed today but unnecessary grant breadth should be reviewed. `service_role` access is intentionally broad and must remain server-only.
4. **Medium — unvalidated foreign keys.** Five tenant/financial composite constraints have not validated historical data. Validate after read-only preflight and lock-impact review.
5. **Low — secrets and logs.** No service-role key was found in browser source; runtime audits store sanitised metadata. Continue secret scanning and avoid request bodies in logs.

RLS was not weakened and permissions were not changed.

## 8. Authentication and session performance

- Admin pages keep protected content hidden until Supabase Auth, role and membership checks complete. Idle logout, warning, multi-tab logout and bfcache revalidation are regression tested.
- The current Super Admin session loaded the API Management page successfully and remained tenant-filtered when switching managed companies.
- Mobile/native architecture uses user/session tokens; permanent integration keys are not embedded in client apps.
- Driver sessions use opaque server-issued session tokens and server-side company/driver resolution.
- Browser inspection found a stale Driver Portal context attempting refresh calls while the login screen was visible, producing a sanitised “Failed to send a request” console error. No credentials were exposed and no write occurred. Clear all driver timers/session state immediately when a refresh proves unauthorised or expired.
- Auth/provider p50/p95 latency and concurrent-session capacity are **UNKNOWN** because provider analytics were inaccessible and stress testing was intentionally avoided.

## 9. Frontend and browser performance

### Measured observations

- Authenticated API Management desktop: navigation load about 181 ms from cache, approximately 121 DOM nodes, 65 registered JS listeners at process scope and 5.7 MB JS heap used. Several Edge/API requests observed over the tab lifetime took approximately 0.3–1.05 s.
- API Management at 390 × 844 had no horizontal overflow (`scrollWidth=390`).
- Driver Portal at 390 × 844 reloaded in approximately 179 ms from cache, with no horizontal overflow.
- Driver page payloads observed included `driver.js` ~19 KB encoded, `driver.css` ~9 KB encoded, navigation helper ~4 KB and Supabase JS ~56 KB from cache/CDN.
- Repository’s largest first-party files are `bookings.js` 93.7 KB, `all-bookings.js` 77.3 KB, `driver.js` 72.4 KB and `booking.js` 71.9 KB. Total sampled HTML/CSS/JS application files were about 1.16 MB uncompressed.
- Largest bundled image is `assets/jeffsLogo.jpeg` at approximately 584 KiB. The live logo store averages much more because historical objects are retained.

### Polling and lifecycle

The Driver Portal polls its main state every seven seconds, stale-text every five seconds and messages every 15 seconds while the messages tab is open. Navigation uses geolocation watch plus five-second GPS freshness checks. Cleanup exists on logout/unload/navigation stop, and intervals are cleared before replacement. SMS Admin polls every 30 seconds when visible and not editing. All Bookings refreshes every 60 seconds.

This is acceptable for ten drivers but is the first likely scaling bottleneck. At ten logged-in hours, one active driver can generate roughly 5,140 main refreshes/day before messages, GPS or map reroutes. Five drivers per company across 100 companies would approach 2.57 million refreshes/day.

### Unbounded views

Several admin screens fetch full tenant collections without server pagination: customers plus all bookings, accounts, invoices, receipts, drivers, vehicles and calendar booking stops. SMS is bounded (1,000 conversations and bounded histories), email delivery history is capped at 50, dashboard is capped at 10, and GPS playback is capped at 5,000. Pagination becomes necessary before high-volume onboarding.

No physical-device claim is made. GPS, backgrounding, thermal/battery behaviour, Android WebView and iPhone Safari were not tested on hardware.

## 10. Capacity forecast

These are order-of-magnitude planning estimates, not quotas or promises. One “company-year” assumptions:

| Scenario | Bookings | Drivers | SMS / booking | Email / booking | GPS points / booking | Receipt attachment rate | Estimated DB / company-year | Estimated file storage / company-year |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Low | 1,000 | 1 | 2 | 3 | 0 | 20% × 0.5 MB | 25 MB | 0.10 GB |
| Medium | 5,000 | 5 | 4 | 5 | 60 | 50% × 0.5 MB | 0.30 GB | 1.25 GB |
| High | 20,000 | 20 | 8 | 8 | 120 | 80% × 0.5 MB | 2.4 GB | 8.0 GB |

The DB estimate bundles bookings, customers, communications, audits, indexes and GPS. Actual attachments are currently zero and GPS points are zero, so those assumptions are deliberately explicit.

### Aggregate annual growth

| Companies | Low DB / files | Medium DB / files | High DB / files |
|---:|---:|---:|---:|
| 5 | 0.13 GB / 0.5 GB | 1.5 GB / 6.3 GB | 12 GB / 40 GB |
| 10 | 0.25 GB / 1 GB | 3 GB / 12.5 GB | 24 GB / 80 GB |
| 20 | 0.5 GB / 2 GB | 6 GB / 25 GB | 48 GB / 160 GB |
| 50 | 1.25 GB / 5 GB | 15 GB / 62.5 GB | 120 GB / 400 GB |
| 100 | 2.5 GB / 10 GB | 30 GB / 125 GB | 240 GB / 800 GB |

Medium communications at 100 companies would be about two million SMS and 2.5 million emails/year. High would be about 16 million of each. Medium GPS would add 30 million points/year; high would add 240 million.

### Bottleneck order

1. Driver polling and Edge Function request volume/latency.
2. Unpaginated admin queries and browser DOM rendering.
3. Receipt/logo object storage and independent backup bandwidth.
4. GPS history table/index growth and playback range scans.
5. Database disk/compute and connection pool at tens of medium/high-volume tenants.
6. Email, SMS and Google Maps paid quotas as communication/map usage grows.

## 11. Cost and upgrade recommendations

Current provider account plans and actual bills are **UNKNOWN**; no purchase is recommended from guesswork.

Official public prices checked on 14 October 2026:

- Supabase documents Free at $0 with 500 MB database and 1 GB Storage, and Pro at $25/month with 8 GB database disk, 100 GB Storage and seven days of daily backups. PITR starts around $100/month for seven-day retention and requires at least Small compute. See [Supabase pricing](https://supabase.com/pricing) and [backup documentation](https://supabase.com/docs/guides/platform/backups).
- Vercel Pro documents a $20/month platform fee with $20 usage credit; actual project plan remains unknown. See [Vercel Pro](https://vercel.com/docs/plans/pro-plan).
- Resend Free documents 3,000 emails/month and 100/day; Pro is $20/month for 50,000/month. Actual account plan/usage is unknown. See [Resend pricing](https://resend.com/pricing).
- Google Maps is pay-as-you-go. Current global Essentials SKUs generally include 10,000 free monthly events; Compute Routes Essentials is then $5/1,000 in the first paid tier. Actual billing/usage is unknown. See [Google Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing).

Recommended upgrade order:

1. **Confirm/upgrade Supabase backup protection first.** This is driven by recoverability, not capacity.
2. Implement independent database + Storage backups and test a restore; provider plan alone is insufficient evidence.
3. Stay on current Vercel capacity until measured 30-day usage, function errors or latency justify Pro; current static delivery is light.
4. Stay on current compute/storage while usage is under 50% of verified quotas, but alert at 50/70/85% and revisit before medium 20-company scale.
5. Move Resend beyond Free before sustained traffic approaches 80 emails/day or 2,400/month, allowing retry/headroom.
6. Add Google Maps budgets and SKU alerts before broad driver-navigation rollout; optimise autocomplete sessions, map reuse and route recomputation first.

## 12. Prioritised improvements

| Recommendation | Severity | Benefit | Risk | Complexity | Migration | Downtime |
|---|---|---|---|---|---|---|
| Establish independent DB + Storage backups and isolated restore test | Critical | Proven recovery path | Medium operational | Medium | No app migration | None for backup; isolated restore only |
| Confirm paid backup entitlement/PITR and document RPO/RTO | Critical | Reduces loss window | Low | Low–Medium | No | Provider restore would have downtime; audit does not |
| Enforce DB SSL and narrow CIDRs after connector inventory | High | Reduces network exposure | Medium compatibility | Medium | No | Possible brief maintenance window |
| Replace 7 s driver polling with event/delta strategy plus backoff | High at scale | Large Edge/network/battery reduction | Medium | High | Possibly | No planned downtime |
| Add server pagination to bookings/customers/accounts/invoices/receipts/drivers | High at scale | Bounded queries and DOM | Medium UX/API | Medium–High | Possibly indexes/RPCs | No |
| Review/fix `SECURITY DEFINER` search paths | Medium | Defence in depth | Medium if signatures change | Medium | Yes | No |
| Validate five `NOT VALID` FKs after orphan preflight | Medium | Historic integrity proof | Lock/validation load | Medium | Yes | Avoid peak; no expected outage at current size |
| Compress logos and review 18 orphan candidates | Medium | Recovers ~32.1 MB now, prevents growth | Deletion risk | Low–Medium | No | No; deletion requires separate approval |
| Add GPS time partitioning/retention and archival before enabling broadly | Medium future | Predictable large-table operations | Medium | High | Yes | Avoidable with additive rollout |
| Investigate schema-introspection temporary I/O | Medium | Lower disk I/O and latency | Low | Medium | No | No |
| Clear stale Driver Portal sessions/timers immediately on unauthorised refresh | Low–Medium | Fewer errors and needless calls | Low | Low | No | No |
| Add provider dashboards/alerts for p95 latency, errors, disk, connections, queues and spend | Medium | Earlier detection | Low | Low–Medium | No | No |

## 13. Immediate, medium and long-term plan

### Immediate (0–7 days)

- Confirm Supabase plan and backup dashboard; do not assume empty CLI results are recoverable backups.
- Approve and implement independent encrypted DB/Storage backup jobs.
- Inventory database clients before SSL/CIDR hardening.
- Add alerts for failed backups, database disk, connections, email queues and function errors.
- Review why a disabled integration and revoked credential now exist; no external service is active and there are no webhooks.

### Medium term (2–8 weeks)

- Run an approved isolated restore and record measured RPO/RTO.
- Add pagination and query projection to all growing admin lists.
- Refactor driver polling with visibility awareness, exponential backoff and delta/realtime updates.
- Harden definer search paths and validate existing composite foreign keys.
- Compress new logos and create an owner-approved orphan-review workflow.

### Long term (before 20+ medium-volume companies)

- Partition/archive GPS and high-volume audit/message histories.
- Introduce queue observability and explicit dead-letter review workflows.
- Use load tests in an isolated production-like environment to establish p95/p99 and connection limits.
- Review Supabase compute, Vercel, Resend and Google Maps using measured 30-day usage and forecasts.
- Exercise company-level export and full disaster recovery at least quarterly.

## 14. Test results and limitations

### Passed

- 293/293 repository tests.
- Release 7.7 rollback bootstrap, role preset, override and company-isolation test.
- Existing-production transaction rollback: owner deletion-permission grant/revoke, ordinary staff denial, cross-company denial and audit generation.
- Anonymous/API/webhook/SMS/mobile/payment/deletion boundaries are covered by the regression suite.
- Four production domain HTTP checks and responsive overflow checks.

### Limitations

- No recovery test; backup recoverability remains UNKNOWN.
- No provider billing page, Supabase CPU/RAM charts, Vercel usage analytics, Resend usage, Google billing, or detailed Edge log analytics were accessible.
- No stress/load test and no physical iPhone/Android test.
- No historical production snapshot was available for measured growth rate.
- No Storage object was opened or deleted; orphan status is a reference-based candidate calculation.
- One audit-created deadlock was safely aborted and disclosed above.

## 15. Audit conclusion

The platform is operationally sound for its current four-company, low-record-count footprint. Tenant isolation, RLS coverage, financial consistency and application regression results are strong. Capacity is not the immediate constraint. Recovery assurance is. Treat verified backups plus an isolated restore exercise as the next production priority, followed by network hardening and removal of polling/unbounded-list bottlenecks before wider onboarding.
