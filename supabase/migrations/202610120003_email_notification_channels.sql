-- Additive channel preferences for future SMS support. Existing email booleans
-- remain authoritative unless a notification key is explicitly configured.

begin;

alter table public.settings
  add column if not exists notification_channels jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.settings'::regclass
      and conname='settings_notification_channels_check'
  ) then
    alter table public.settings add constraint settings_notification_channels_check
      check (jsonb_typeof(notification_channels)='object');
  end if;
end $$;

comment on column public.settings.notification_channels is
  'Optional per-notification channel arrays (email, sms). Missing keys preserve legacy email boolean behaviour; SMS delivery is not implemented.';

notify pgrst,'reload schema';
commit;
