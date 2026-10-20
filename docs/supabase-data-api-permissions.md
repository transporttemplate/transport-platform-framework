# Supabase Data API permissions

From 30 October 2026, a newly created `public` table must not depend on Supabase automatically granting Data API privileges. PostgreSQL object grants and Row Level Security are independent gates: a request needs both an applicable role grant and an RLS policy that permits the row.

## Required migration workflow

Use `supabase/templates/public-table-migration.template.sql` whenever a migration creates a public table.

1. Enable RLS immediately after `create table`.
2. Revoke all privileges from `public`, `anon`, `authenticated`, and `service_role` to establish an explicit baseline.
3. Grant only operations used by the implemented workflow. Never use `grant all` for Data API roles.
4. Add RLS policies separately for every browser role receiving a grant.
5. Grant sequence privileges separately when inserts use an identity or serial sequence.
6. Prefer Edge Functions with `service_role` for sensitive workflows. Never expose service credentials to a browser.
7. Anonymous access requires a documented public use case, column-level grants where possible, and a restrictive `to anon` policy.

Private bookings, customers, drivers, payments, credentials, tokens, membership records, integration state, audit records, messages, and financial data must never receive anonymous Data API privileges.

## Current project audit — 20 October 2026

The live project contains 109 public tables. All 109 have RLS enabled. The catalog has no public-schema default ACL entries, so future migrations cannot safely assume any role receives access automatically.

Thirty repository migrations create 96 public tables:

- `202609030001_finance_invoices_email_stops_statements.sql`
- `202609040001_stage1b_driver_customer_security.sql`
- `202609050001_account_customers.sql`
- `202609060002_company_domains.sql`
- `202609070002_company_public_site_controls.sql`
- `202609070005_professional_finance_receipts.sql`
- `202609080005_all_bookings_customer_portal_driver_payment.sql`
- `202610090001_driver_diary_workflow.sql`
- `202610110001_admin_edit_booking.sql`
- `202610110002_email_automation.sql`
- `202610110004_resend_webhook_safety.sql`
- `202610110005_email_scheduler_safety.sql`
- `202610120001_release_4_smart_availability.sql`
- `202610120004_empty_legs.sql`
- `202610120007_historical_return_repair.sql`
- `202610120008_release6_sms_gateway.sql`
- `202610130002_release7_driver_accounts.sql`
- `202610140001_release73_dispatch_communications.sql`
- `202610140004_release75_api_management.sql`
- `202610140005_booking_deletion_permission_management.sql`
- `202610140007_release77_roles_permissions.sql`
- `202610150001_release79_integrations_centre.sql`
- `202610150002_release80_job_exchange.sql`
- `202610150003_release802_external_dispatch.sql`
- `202610170001_release804_operations.sql`
- `202610170004_release806_accounts_dispatch_webhooks.sql`
- `202610170005_release807_external_dispatch_reliability.sql`
- `202610190001_driver_vehicle_linking.sql`
- `202610190002_release81_automatic_api_hooks.sql`
- `202610190003_release82_office_notifications.sql`

Historical migrations are preserved. Later security migrations already narrow their effective live grants, especially `202609050002_immediate_data_api_security.sql` and `202609050003_post_public_booking_cutover.sql`.

### Intended Data API surfaces

- `anon`: public company identity, approved public settings columns, active airports, service areas, company domains, and fleet presentation only.
- `authenticated`: tenant-scoped Admin operational tables and audit projections required by browser workflows.
- `service_role`: server-only Driver Portal, public booking creation, payments, email/SMS, integrations, API, Job Exchange, security and token workflows.
- no browser grant: credentials, nonces, pairing attempts, rate buckets, tracking/claim tokens, server audit tables and other server-only state.

The live audit found a legacy automatic anonymous table grant on `company_users`. RLS denied anonymous rows, but the grant was unnecessary and is revoked by `202610200001_data_api_permission_compatibility.sql`. No other existing production grant is changed.

## Synthetic verification

`scripts/security/data-api-permission-probe.sql` creates a transaction-scoped table using the new explicit model. It verifies that `anon` and `authenticated` receive SQLSTATE `42501`, verifies the deliberately granted `service_role` access, and rolls the table back. The production audit passed all three expectations and confirmed the probe table was absent afterward.
