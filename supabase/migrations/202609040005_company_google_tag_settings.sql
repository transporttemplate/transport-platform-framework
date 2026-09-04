-- Additive only. Apply manually when company-managed Google tags are enabled.
begin;

alter table public.settings
  add column if not exists googleanalyticsid text,
  add column if not exists googleadsid text,
  add column if not exists googleadsconversionlabel text;

comment on column public.settings.googleanalyticsid is 'Public GA measurement ID, for example G-XXXXXXXXXX.';
comment on column public.settings.googleadsid is 'Public Google Ads conversion ID, for example AW-XXXXXXXXX.';
comment on column public.settings.googleadsconversionlabel is 'Public Google Ads conversion label.';

-- These values and booking switches are public website configuration, not secrets.
grant select (
  googleanalyticsid, googleadsid, googleadsconversionlabel,
  returnbookings, multiplestops, allowcash, allowcard, requiredeposit,
  airportdepositrequired, depositpercent
) on public.settings to anon;

notify pgrst, 'reload schema';

commit;
