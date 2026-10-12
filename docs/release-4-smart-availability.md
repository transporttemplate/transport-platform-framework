# Release 4 — Fully Booked & Smart Availability

## Completion summary

Release 4 adds company-scoped manual Fully Booked periods, recurring periods,
driver leave management, calendar indicators, public preflight feedback,
server-side enforcement, and audited Admin overrides. It is implemented on
`feature/release-4-smart-availability`; nothing in this release deploys or
migrates production automatically.

### Data model and security

- `availability_blocks` stores half-open `[starts_at, ends_at)` periods, whole-day
  state, optional internal reason, daily/weekly recurrence and audit principals.
- `availability_block_audit` preserves create, edit and soft-delete history.
- `availability_override_audit` records the booking, conflicting block IDs,
  authorised Admin, time and required reason.
- Every record carries `company_id`. Authenticated access is restricted by the
  existing `user_can_access_company` resolver and RLS. Public clients receive no
  table grants; the existing server function resolves the company UUID from its
  public code.
- Driver leave reuses `driver_unavailability`. Approval metadata is additive;
  existing records default to approved and are not rewritten.

### Enforcement and duration policy

The public function checks outbound and return journeys independently after the
authoritative route duration is available, then repeats the check immediately
before insert. A database trigger is the final authority. It takes a
transaction-scoped advisory lock per company/date and checks again, preventing
simultaneous requests from bypassing a newly created block.

Reliable `route_duration_minutes` plus the company turnaround buffer define the
occupied interval. When duration is genuinely unavailable, the checker uses a
documented one-minute pickup interval rather than inventing a journey length.
Intervals are half-open, so a journey ending exactly when a block begins does
not conflict. Recurrence is generated in company local wall time and converted
with PostgreSQL `AT TIME ZONE`, preserving local time through BST/GMT changes.

Automatic capacity settings are prepared but `automatic_capacity_enforced` is
false for every existing and new company. No capacity-based public rejection is
activated until driver/vehicle suitability data has been validated per company.

### Admin and calendar

`availability.html` now provides list/calendar views and mobile-friendly create,
edit, soft-delete, whole-day, partial-day, overnight, multi-day and daily/weekly
recurring controls. It also retains live driver status and adds leave creation.
When leave overlaps an assigned job the Admin receives an explicit warning;
bookings are never cancelled or reassigned.

`calendar.html` retains existing booking and Google Calendar behavior and adds
separate Fully Booked and driver-leave markers. This release does not sync
availability blocks to Google Calendar.

### Public booking and overrides

Date/time changes perform a lightweight availability preflight. This is advisory;
the server and database always revalidate. Customers cannot supply override
fields because the public payload allow-list excludes them. Admin booking entry
shows a prominent conflict warning, requires confirmation and a non-empty reason,
and leaves the original block intact.

## Known limitations

- Recurrence supports daily and weekly patterns, not arbitrary RFC 5545 rules.
- Calendar recurrence markers currently show stored occurrences in the month
  view; enforcement expands every occurrence correctly server-side.
- Vehicle suitability and luggage-capacity data are not sufficiently complete
  for safe automatic rejection, so smart capacity remains observation-only/off.
- Driver self-service leave remains governed by the existing driver portal API;
  the Admin page records approved leave and exposes existing current status.
- Suggested alternative times are intentionally not displayed yet: without a
  validated capacity model, a block end alone is not a reliable promise of a
  bookable slot.

## Deployment plan

1. Review the feature-branch diff and security/test report.
2. Take/verify the normal Supabase database backup and record current migration
   history. Do not change secrets, Stripe, Maps, Resend or scheduler settings.
3. In staging, apply `202610120001_release_4_smart_availability.sql`, deploy the
   updated `public-booking-create` function, then deploy static assets.
4. Run synthetic tests for companies 0001–0004, including cross-company access,
   both UK DST boundaries, outbound/return conflicts, and rollback-only booking
   attempts. Do not send email or initiate payment intents.
5. Obtain explicit production approval. Apply the migration before the function
   and UI to ensure the database guard exists when the feature becomes visible.
6. Confirm `automatic_capacity_enforced=false` for every company and leave the
   email scheduler unchanged.

## Rollback

Prefer an application rollback: restore the previous static assets and edge
function while leaving the additive tables/columns in place. They are inert for
older code and preserve audit evidence. Disable enforcement without deleting
data by dropping only `enforce_booking_availability_trigger` in an approved
hotfix transaction. A full schema rollback requires a maintenance window:
export Release 4 tables, drop Release 4 triggers/functions/policies/tables, then
drop only the newly added columns. Never remove or rewrite booking, payment,
customer, driver or email records as part of rollback.
