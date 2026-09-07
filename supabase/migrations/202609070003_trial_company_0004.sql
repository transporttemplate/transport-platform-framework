-- Add the platform-controlled trial lifecycle and create clean trial tenant 0004.
-- Additive and idempotent: no existing company or settings rows are overwritten.

begin;

alter table public.companies
  add column if not exists company_status text not null default 'active';
alter table public.companies
  add column if not exists trial_started_at timestamptz;
alter table public.companies
  add column if not exists trial_expires_at timestamptz;
alter table public.companies
  add column if not exists trial_grace_expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'companies_company_status_check'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
      add constraint companies_company_status_check
      check (company_status in ('trial', 'active', 'suspended', 'cancelled'));
  end if;
end $$;

-- Authenticated members may display lifecycle state for companies their existing
-- RLS membership permits them to read. No browser UPDATE grant is introduced.
grant select (
  company_status, trial_started_at, trial_expires_at, trial_grace_expires_at
) on table public.companies to authenticated;

create or replace function public.enforce_trial_settings_restrictions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.companies
    where id = new.company_id and company_status = 'trial'
  ) then
    if coalesce(new.allowcard, false)
      or coalesce(new.enablestripe, false)
      or nullif(btrim(coalesce(new.stripepublishablekey, '')), '') is not null
      or coalesce(new.requiredeposit, false)
      or coalesce(new.airportdepositrequired, false)
    then
      raise exception 'Stripe, card and deposit payments are not available during the trial';
    end if;
    if coalesce(new.emailnotifications, false)
      or coalesce(new.customer_booking_emails, false)
      or coalesce(new.office_new_booking_emails, false)
      or coalesce(new.driver_assignment_emails, false)
      or coalesce(new.booking_change_emails, false)
      or coalesce(new.cancellation_emails, false)
      or coalesce(new.payment_confirmation_emails, false)
      or coalesce(new.unallocated_reminder_emails, false)
    then
      raise exception 'Production email is not available during the trial';
    end if;
  end if;
  return new;
end $$;

revoke all on function public.enforce_trial_settings_restrictions()
from public, anon, authenticated;

drop trigger if exists settings_enforce_trial_restrictions on public.settings;
create trigger settings_enforce_trial_restrictions
before insert or update on public.settings
for each row execute function public.enforce_trial_settings_restrictions();

create or replace function public.convert_trial_company_to_active(target_company_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  converted_company_id uuid;
begin
  update public.companies
  set company_status = 'active',
      trial_expires_at = null,
      trial_grace_expires_at = null
  where company_code = trim(target_company_code)
    and company_status in ('trial', 'suspended')
  returning id into converted_company_id;

  if converted_company_id is null then
    raise exception 'Trial company was not found or is not convertible';
  end if;
  return converted_company_id;
end $$;

revoke all on function public.convert_trial_company_to_active(text)
from public, anon, authenticated;
grant execute on function public.convert_trial_company_to_active(text)
to service_role;

do $$
declare
  trial_company_id public.companies.id%TYPE;
begin
  select id into trial_company_id
  from public.companies
  where company_code = '0004';

  if trial_company_id is null then
    trial_company_id := gen_random_uuid();
    insert into public.companies (
      id, company_code, name, trading_name,
      company_status, trial_started_at, trial_expires_at,
      trial_grace_expires_at
    ) values (
      trial_company_id, '0004', 'A&R Minibus Hire', 'A&R Minibus Hire',
      'trial', now(), now() + interval '14 days', now() + interval '21 days'
    );
  end if;

  if not exists (
    select 1 from public.settings where company_id = trial_company_id
  ) then
    insert into public.settings (
      company_id, companyname, tradingname, businessstatus, timezone,
      allowcash, enablecash, allowcard, enablestripe,
      stripepublishablekey, requiredeposit, airportdepositrequired,
      allowaccounts, enableaccounts, airportpricing, distancecalculator,
      emailnotifications, customer_booking_emails,
      office_new_booking_emails, driver_assignment_emails,
      booking_change_emails, cancellation_emails,
      payment_confirmation_emails, unallocated_reminder_emails
    ) values (
      trial_company_id, 'A&R Minibus Hire', 'A&R Minibus Hire', 'open', 'Europe/London',
      true, true, false, false,
      null, false, false,
      false, false, false, true,
      false, false,
      false, false,
      false, false,
      false, false
    );
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
