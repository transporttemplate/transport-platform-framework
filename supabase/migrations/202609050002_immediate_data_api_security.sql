-- Immediate Data API/RLS remediation that is safe before the authoritative
-- public-booking-create cutover.
--
-- This migration deliberately preserves:
--   * the anonymous booking_stops INSERT grant and policy
--   * anonymous EXECUTE on booking_matches_company(uuid, uuid)
-- They are removed only by the ordered post-cutover migration.
--
-- Non-destructive: no tables or rows are dropped, truncated, deleted or changed.

begin;

-- Public company resolution needs only these identity fields. Authenticated
-- company context is restricted to a company linked to the current user.
alter table public.companies enable row level security;

revoke all on table public.companies from public, anon, authenticated;
grant select (id, company_code, name, trading_name)
  on table public.companies to anon, authenticated;

drop policy if exists public_company_identity on public.companies;
drop policy if exists authenticated_company_identity on public.companies;

create policy public_company_identity
on public.companies for select to anon
using (company_code is not null);

create policy authenticated_company_identity
on public.companies for select to authenticated
using (public.user_can_access_company(id));

-- Airports retain only the public projection used by public pages. All writes
-- require an authenticated membership for the row's company_id.
alter table public.airports enable row level security;

drop policy if exists airports_select on public.airports;
drop policy if exists airports_insert on public.airports;
drop policy if exists airports_update on public.airports;
drop policy if exists airports_delete on public.airports;
drop policy if exists public_active_airports on public.airports;
drop policy if exists public_active_airports_restrictive on public.airports;
drop policy if exists admin_company_airports on public.airports;
drop policy if exists admin_company_airports_restrictive on public.airports;

revoke all on table public.airports from public, anon, authenticated;
grant select (
  id, company_id, name, code, active,
  price_1_4_oneway, price_1_4_return,
  price_5_7_oneway, price_5_7_return,
  deposit_percent, sort_order
) on table public.airports to anon;
grant select, insert, update, delete on table public.airports to authenticated;

create policy public_active_airports
on public.airports for select to anon
using (active is true and company_id is not null);

create policy admin_company_airports
on public.airports for all to authenticated
using (public.user_can_access_company(company_id))
with check (public.user_can_access_company(company_id));

-- Remove every known overlapping Service Area policy and rebuild one public
-- read policy plus one authenticated tenant-admin policy.
alter table public.service_areas enable row level security;

drop policy if exists service_areas_select on public.service_areas;
drop policy if exists service_areas_insert on public.service_areas;
drop policy if exists service_areas_update on public.service_areas;
drop policy if exists service_areas_delete on public.service_areas;
drop policy if exists public_active_service_areas on public.service_areas;
drop policy if exists public_active_service_areas_restrictive on public.service_areas;
drop policy if exists admin_company_service_areas on public.service_areas;
drop policy if exists admin_company_service_areas_restrictive on public.service_areas;

revoke all on table public.service_areas from public, anon, authenticated;
grant select (
  id, company_id, area_name, postcode_prefix,
  radius_miles, active, sort_order
) on table public.service_areas to anon;
grant select, insert, update, delete on table public.service_areas to authenticated;

create policy public_active_service_areas
on public.service_areas for select to anon
using (active is true and company_id is not null);

create policy admin_company_service_areas
on public.service_areas for all to authenticated
using (public.user_can_access_company(company_id))
with check (public.user_can_access_company(company_id));

-- These empty legacy tables have no repository runtime browser usage. Keep the
-- schemas and data intact, but make browser access deny-by-default.
alter table public.activity_log enable row level security;
alter table public.availability enable row level security;
alter table public.expenses enable row level security;
alter table public.offices enable row level security;
alter table public.users enable row level security;
alter table public.vehicles enable row level security;

revoke all on table
  public.activity_log,
  public.availability,
  public.expenses,
  public.offices,
  public.users,
  public.vehicles
from public, anon, authenticated;

-- Remove anonymous privileges from private operational data. booking_stops is
-- handled separately below because the currently deployed public booking flow
-- still requires its legacy anonymous INSERT path.
revoke all on table
  public.company_counters,
  public.customers,
  public.bookings,
  public.drivers,
  public.driver_sessions,
  public.driver_unavailability,
  public.security_rate_limits,
  public.driver_statements,
  public.driver_statement_items,
  public.invoices,
  public.invoice_items,
  public.payments,
  public.email_templates,
  public.email_deliveries
from public, anon;

-- Anonymous visitors must not read, update or delete booking stops. Preserve a
-- direct anon INSERT grant and the existing public_insert_booking_stops policy.
revoke select, update, delete on table public.booking_stops from public, anon;
revoke insert on table public.booking_stops from public;
grant insert on table public.booking_stops to anon;

-- Server-only tables have no authenticated browser privileges.
revoke all on table
  public.company_counters,
  public.driver_sessions,
  public.security_rate_limits
from authenticated;

-- Re-state only operations exercised by current authenticated admin code.
revoke all on table
  public.customers,
  public.bookings,
  public.booking_stops,
  public.driver_unavailability,
  public.driver_statements,
  public.driver_statement_items,
  public.invoices,
  public.invoice_items,
  public.payments,
  public.email_templates,
  public.email_deliveries
from authenticated;

grant select on table public.customers to authenticated;
grant select, insert, update, delete on table public.bookings to authenticated;
grant select, insert on table public.booking_stops to authenticated;
grant select on table public.driver_unavailability to authenticated;
grant select, insert, update on table public.driver_statements to authenticated;
grant select, insert on table public.driver_statement_items to authenticated;
grant select, insert, update on table public.invoices to authenticated;
grant select, insert on table public.invoice_items to authenticated;
grant select, insert, update on table public.email_templates to authenticated;
grant select on table public.email_deliveries to authenticated;

-- Driver writes occur through driver-portal. Browser administrators receive
-- only the non-sensitive columns used by the Admin UI.
revoke all on table public.drivers from authenticated;
grant select (
  id, company_id, driver_number, full_name, phone, email, vehicle,
  licence_number, licence_expiry, status, online, latitude, longitude,
  location_updated_at, pay_type, commission_percent, fixed_job_amount
) on table public.drivers to authenticated;

-- link_booking_to_invoice is invoked by the existing AFTER INSERT trigger.
-- Removing direct browser EXECUTE does not remove or disable that trigger.
revoke all on function public.link_booking_to_invoice()
  from public, anon, authenticated;

-- Intentionally untouched until the post-cutover migration:
--   public_insert_booking_stops
--   booking_matches_company(uuid, uuid) anonymous EXECUTE

notify pgrst, 'reload schema';

commit;
