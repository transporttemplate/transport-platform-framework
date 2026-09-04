-- Records the anonymous settings privilege correction applied manually in the
-- live database on 2026-09-04. Do not re-apply to live without first checking
-- migration history with the platform owner.
--
-- RLS continues to control which company settings rows anon may read. These
-- grants additionally restrict anon to the public-safe columns below. Existing
-- authenticated company-scoped settings policies and privileges are unchanged.

begin;

alter table public.settings enable row level security;

-- PUBLIC privileges are inherited by anon/authenticated and must also be
-- removed; checking only grants assigned directly to anon can miss this path.
revoke select on table public.settings from public;
revoke select on table public.settings from anon;

do $$
declare
  settings_column record;
begin
  for settings_column in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'settings'
  loop
    execute format(
      'revoke select (%I) on table public.settings from anon',
      settings_column.column_name
    );
    execute format(
      'revoke select (%I) on table public.settings from public',
      settings_column.column_name
    );
  end loop;
end
$$;

grant select (
  company_id,
  companyname,
  tradingname,
  companyphone,
  companyemail,
  companywebsite,
  companyaddress,
  companylogo,
  currencysymbol,
  primarycolour,
  secondarycolour,
  accentcolour,
  buttoncolour,
  buttontextcolour,
  businessstatus,
  holidayfrom,
  holidayfromtime,
  holidayto,
  holidaytotime,
  websitenotice,
  acceptadvancebookings,
  bookwhileclosed,
  closedmessage,
  timezone,
  airportpricing,
  distancecalculator,
  allowairportoutsidearea,
  maxadvancedays,
  minimumnotice,
  minimumfare,
  firstmile,
  mileband1,
  mileband2,
  mileband3,
  mileband4,
  mileband5,
  mileband6,
  bookingfee,
  returndiscount,
  returnbookings,
  multiplestops,
  allowcash,
  allowcard,
  enablecash,
  enablestripe,
  requiredeposit,
  airportdepositrequired,
  depositpercent,
  googlemapsapi
)
on table public.settings
to anon;

notify pgrst, 'reload schema';

commit;
